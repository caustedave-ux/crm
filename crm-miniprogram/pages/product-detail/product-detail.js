const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');
const images = require('../../utils/images');

Page({
  data: {
    id: 0,
    loading: true,
    errMsg: '',
    product: null,
    moves: [],
    rows: [],
    imageUrls: [],
  },

  onLoad(options) {
    const id = Number(options.id || 0);
    this.setData({ id });
    this.refresh();
  },

  async refresh() {
    const id = this.data.id;
    if (!id) {
      this.setData({ loading: false, errMsg: '缺少产品 ID' });
      return;
    }
    await auth.guardSession();

    this.setData({ loading: true, errMsg: '' });
    try {
      const p = await api.getProduct(id);
      const stock = Number(p.stock) || 0;
      const alert = Number(p.stock_alert) || 0;
      const product = Object.assign({}, p, {
        stockText: fmt.qty(stock),
        priceText: fmt.money(p.price, p.currency),
        costText: fmt.money(p.cost_price, p.currency),
        low: alert > 0 && stock <= alert,
        hasAlert: alert > 0,
        createdText: p.created_at ? String(p.created_at).slice(0, 10) : '',
        updatedText: p.updated_at ? String(p.updated_at).slice(0, 16) : '',
      });

      const rows = [];
      const push = (label, value) => {
        if (value === '' || value === null || value === undefined) return;
        rows.push({ label, value: String(value) });
      };
      push('英文名', p.name_en);
      push('型号', p.model);
      push('HS编码', p.hs_code);
      push('产地', p.origin);
      push('颜色', p.color);
      push('单位', p.unit);
      push('每箱数量', p.pcs_per_ctn ? fmt.qty(p.pcs_per_ctn) + ' pcs/ctn' : '');
      push('箱数', p.ctn_count ? fmt.qty(p.ctn_count) + ' ctn' : '');
      push('体积', p.volume ? fmt.qty(p.volume) + ' CBM' : '');
      push('重量', p.weight ? fmt.qty(p.weight) + ' KG' : '');
      push('备注', p.notes);

      let moves = [];
      try {
        const res = await api.listStockMovements({ productId: id, page: 1 });
        moves = res.list.slice(0, 5);
      } catch (e) {
        moves = [];
      }

      // 图片需换签名 URL 才能展示
      let imageUrls = [];
      try {
        const paths = images.parseImages(p.images);
        const map = await images.signUrls(paths);
        imageUrls = paths.map((pth) => map[pth]).filter(Boolean);
      } catch (e) {
        imageUrls = [];
      }

      wx.setNavigationBarTitle({ title: p.name || '产品详情' });
      this.setData({ product, rows, moves, imageUrls, loading: false });
    } catch (e) {
      this.setData({ loading: false, errMsg: (e && e.message) || '产品加载失败' });
    }
  },

  onPreviewImage(e) {
    const urls = this.data.imageUrls || [];
    if (!urls.length) return;
    wx.previewImage({ current: e.currentTarget.dataset.url || urls[0], urls });
  },

  async onEdit() {
    const session = await auth.requireLogin();
    if (!session) return;
    wx.navigateTo({ url: '/pages/product-edit/product-edit?id=' + this.data.id });
  },

  onAdjust() {
    auth.requireLogin().then((session) => {
      if (!session) return;
      wx.navigateTo({ url: '/pages/stock/stock?productId=' + this.data.id });
    });
  },

  onAllMoves() {
    wx.navigateTo({ url: '/pages/stock-log/stock-log?productId=' + this.data.id });
  },

  onDelete() {
    auth.requireLogin().then((session) => {
      if (!session) return;
      this.confirmDelete();
    });
  },

  confirmDelete() {
    const name = (this.data.product && this.data.product.name) || '该产品';
    wx.showModal({
      title: '删除产品',
      content: '确定删除「' + name + '」？删除后不可恢复。',
      confirmColor: '#e0483d',
      success: async (r) => {
        if (!r.confirm) return;
        wx.showLoading({ title: '删除中', mask: true });
        try {
          await api.deleteProduct(this.data.id);
          wx.hideLoading();
          const pages = getCurrentPages();
          const prev = pages[pages.length - 2];
          if (prev && typeof prev.refresh === 'function') prev.refresh();
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 600);
        } catch (e) {
          wx.hideLoading();
          wx.showModal({ title: '删除失败', content: (e && e.message) || '删除失败', showCancel: false });
        }
      },
    });
  },

  copyValue(e) {
    const value = e.currentTarget.dataset.value;
    if (!value) return;
    wx.setClipboardData({ data: String(value) });
  },
});
