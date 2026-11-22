const api = require('../../utils/api');
const auth = require('../../utils/auth');
const images = require('../../utils/images');

function emptyForm() {
  return {
    name: '', name_en: '', model: '', hs_code: '', unit: '',
    price: '', currency: 'USD', cost_price: '',
    origin: '', stock: '', stock_alert: '',
    pcs_per_ctn: '', volume: '', weight: '', ctn_count: '', color: '',
    notes: '', is_shared: false,
  };
}

Page({
  data: {
    isEdit: false,
    id: 0,
    loading: false,
    saving: false,
    currencies: [],
    currencyIndex: 0,
    form: emptyForm(),
    images: [],
    removedPaths: [],
    maxImages: 6,
  },

  onLoad(options) {
    this.setData({ currencies: api.CURRENCIES, maxImages: images.MAX_IMAGES });
    const id = Number(options.id || 0);
    if (id) {
      this.setData({ isEdit: true, id });
      wx.setNavigationBarTitle({ title: '编辑产品' });
      this.loadProduct(id);
    } else {
      wx.setNavigationBarTitle({ title: '新增产品' });
    }
  },

  async loadProduct(id) {
    this.setData({ loading: true });
    try {
      await auth.guardSession();
      const p = await api.getProduct(id);
      const form = emptyForm();
      api.PRODUCT_FIELDS.forEach((k) => {
        if (p[k] !== undefined && p[k] !== null) form[k] = p[k];
      });
      form.is_shared = !!p.is_shared;
      let ci = api.CURRENCIES.indexOf(form.currency);
      if (ci < 0) ci = 0;
      if (ci === 0 && !form.currency) form.currency = api.CURRENCIES[0];

      // 已有图片换签名 URL 后才能显示
      let imgList = [];
      try {
        const paths = images.parseImages(p.images);
        const map = await images.signUrls(paths);
        imgList = paths.map((pth) => ({ path: pth, temp: '', url: map[pth] || '' }));
      } catch (e) {
        imgList = images.parseImages(p.images).map((pth) => ({ path: pth, temp: '', url: '' }));
      }

      this.setData({ form, currencyIndex: ci, images: imgList, loading: false });
    } catch (e) {
      this.setData({ loading: false });
      wx.showModal({
        title: '加载失败',
        content: (e && e.message) || '产品加载失败',
        showCancel: false,
        success: () => wx.navigateBack(),
      });
    }
  },

  // ---------- 产品图片 ----------
  onChooseImage() {
    const left = this.data.maxImages - this.data.images.length;
    if (left <= 0) {
      wx.showToast({ title: '最多 ' + this.data.maxImages + ' 张', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res.tempFiles || []).map((f) => ({
          path: '', temp: f.tempFilePath, url: f.tempFilePath,
        }));
        this.setData({ images: this.data.images.concat(files) });
      },
    });
  },

  onRemoveImage(e) {
    const idx = Number(e.currentTarget.dataset.index);
    const item = this.data.images[idx];
    if (!item) return;
    const removed = item.path ? this.data.removedPaths.concat([item.path]) : this.data.removedPaths;
    const list = this.data.images.filter((_, i) => i !== idx);
    this.setData({ images: list, removedPaths: removed });
  },

  onPreviewImage(e) {
    const url = e.currentTarget.dataset.url;
    const urls = this.data.images.map((x) => x.url).filter(Boolean);
    if (!urls.length) return;
    wx.previewImage({ current: url || urls[0], urls });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = {};
    patch['form.' + field] = e.detail.value;
    this.setData(patch);
  },

  onCurrencyChange(e) {
    const i = Number(e.detail.value);
    this.setData({
      currencyIndex: i,
      'form.currency': this.data.currencies[i] || 'USD',
    });
  },

  onShareToggle(e) {
    this.setData({ 'form.is_shared': e.detail.value });
  },

  async onSave() {
    if (this.data.saving) return;
    const form = this.data.form;
    if (!String(form.name || '').trim()) {
      wx.showToast({ title: '请填写产品名称', icon: 'none' });
      return;
    }
    if (form.stock !== '' && isNaN(Number(form.stock))) {
      wx.showToast({ title: '库存必须是数字', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    try {
      const session = await auth.requireLogin();
      if (!session) { this.setData({ saving: false }); wx.hideLoading(); return; }
      const uid = (session.user && session.user.id) || '';

      // 先把新选的图传到云端，拿到路径后随产品一起保存
      const temps = this.data.images.filter((x) => !x.path && x.temp).map((x) => x.temp);
      let uploaded = [];
      if (temps.length) {
        wx.showLoading({ title: '上传图片 ' + temps.length + ' 张', mask: true });
        uploaded = await images.uploadImages(temps, uid);
      }
      const paths = [];
      this.data.images.forEach((x) => {
        if (x.path) paths.push(x.path);
        else paths.push(uploaded.shift() || '');
      });
      form.images = paths.filter(Boolean);

      wx.showLoading({ title: '保存中', mask: true });
      if (this.data.isEdit) await api.updateProduct(this.data.id, form);
      else await api.createProduct(form);

      // 被移除的旧图从存储删除，失败不影响保存结果
      if (this.data.removedPaths.length) {
        try { await images.removeImages(this.data.removedPaths); } catch (e) {}
      }
      wx.hideLoading();

      // 让上一页（详情/列表）刷新
      const pages = getCurrentPages();
      const prev = pages[pages.length - 2];
      if (prev && typeof prev.refresh === 'function') prev.refresh();

      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      wx.hideLoading();
      const msg = (e && e.message) || '保存失败';
      const tip = /权限|policy|RLS/i.test(msg) ? '\n\n该产品为只读数据，可能无权修改。' : '';
      wx.showModal({ title: '保存失败', content: msg + tip, showCancel: false });
    }
    this.setData({ saving: false });
  },

  onCancel() {
    wx.navigateBack();
  },
});
