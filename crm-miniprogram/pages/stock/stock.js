const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

const TABS = [
  { key: 'all', name: '全部' },
  { key: 'low', name: '低库存预警' },
  { key: 'zero', name: '零库存' },
  { key: 'has', name: '有库存' },
];

Page({
  data: {
    loading: true,
    errMsg: '',
    kw: '',
    tab: 'all',
    tabs: TABS,
    types: api.STOCK_MOVE_TYPES,
    rows: [],
    list: [],
    stats: { total: 0, low: 0, zero: 0, noAlert: 0, qty: 0, qtyText: '0', values: [] },
    showNoAlertTip: false,
    modal: { show: false, productId: 0, name: '', stock: 0, unit: '', type: 'in', qty: '', remark: '' },
    submitting: false,
  },

  onLoad(options) {
    this.pendingProductId = Number(options.productId || 0) || 0;
    this.refresh();
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh());
  },

  async refresh() {
    await auth.guardSession();
    this.setData({ loading: true, errMsg: '' });
    try {
      const rows = await api.listStockProducts();
      this.setData({ rows, loading: false }, () => {
        this.applyFilter();
        if (this.pendingProductId) {
          const pid = this.pendingProductId;
          this.pendingProductId = 0;
          const row = rows.filter((r) => Number(r.id) === pid)[0];
          if (row) this.openModal(row);
          else wx.showToast({ title: '未找到该产品', icon: 'none' });
        }
      });
    } catch (e) {
      this.setData({ loading: false, errMsg: (e && e.message) || '库存数据加载失败' });
    }
  },

  applyFilter() {
    const kw = String(this.data.kw || '').trim().toLowerCase();
    const tab = this.data.tab;
    const list = this.data.rows.filter((r) => {
      if (tab === 'low' && !r.low) return false;
      if (tab === 'zero' && !r.zero) return false;
      if (tab === 'has' && r.zero) return false;
      if (!kw) return true;
      const hay = [r.name, r.name_en, r.model].join(' ').toLowerCase();
      return hay.indexOf(kw) >= 0;
    });
    const stats = api.summarizeStock(this.data.rows);
    this.setData({
      list,
      stats,
      showNoAlertTip: stats.low === 0 && stats.noAlert > 0,
    });
  },

  onSearchInput(e) {
    this.setData({ kw: e.detail.value }, () => this.applyFilter());
  },

  onTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key }, () => this.applyFilter());
  },

  onDetail(e) {
    wx.navigateTo({ url: '/pages/product-detail/product-detail?id=' + e.currentTarget.dataset.id });
  },

  async onAdd() {
    const session = await auth.requireLogin();
    if (!session) return;
    wx.navigateTo({ url: '/pages/product-edit/product-edit' });
  },

  onLogs() {
    wx.navigateTo({ url: '/pages/stock-log/stock-log' });
  },

  // ---------- 库存调整弹层 ----------
  openModal(row) {
    this.setData({
      modal: {
        show: true,
        productId: Number(row.id),
        name: row.name || '',
        stock: Number(row.stock) || 0,
        unit: row.unit || '',
        type: 'in',
        qty: '',
        remark: '',
      },
    });
  },

  async onAdjust(e) {
    const session = await auth.requireLogin();
    if (!session) return;
    const id = Number(e.currentTarget.dataset.id);
    const row = this.data.rows.filter((r) => Number(r.id) === id)[0];
    if (!row) return;
    this.openModal(row);
  },

  onModalType(e) {
    this.setData({ 'modal.type': e.currentTarget.dataset.key });
  },

  onModalInput(e) {
    const f = e.currentTarget.dataset.field;
    const patch = {};
    patch['modal.' + f] = e.detail.value;
    this.setData(patch);
  },

  onModalClose() {
    this.setData({ 'modal.show': false });
  },

  stopPop() {},

  async onModalSubmit() {
    if (this.data.submitting) return;
    const session = await auth.requireLogin();
    if (!session) return;
    const m = this.data.modal;
    const qty = Number(m.qty);
    if (!isFinite(qty) || String(m.qty).trim() === '') {
      wx.showToast({ title: '请输入数量', icon: 'none' });
      return;
    }
    if (m.type === 'out' && qty > m.stock) {
      const ok = await new Promise((resolve) => {
        wx.showModal({
          title: '库存将变为负数',
          content: '当前库存 ' + m.stock + '，出库 ' + qty + ' 后结存为 ' + (m.stock - qty) + '。是否继续？',
          confirmText: '继续',
          success: (r) => resolve(!!r.confirm),
        });
      });
      if (!ok) return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中', mask: true });
    try {
      const res = await api.adjustStock({
        productId: m.productId,
        product: { id: m.productId, name: m.name, stock: m.stock },
        type: m.type,
        qty,
        remark: m.remark,
      });
      wx.hideLoading();
      this.setData({ 'modal.show': false, submitting: false });

      // 本地更新该行，避免整页重拉
      const rows = this.data.rows.map((r) => {
        if (Number(r.id) !== Number(m.productId)) return r;
        const stock = res.after;
        const alert = Number(r.stock_alert) || 0;
        return Object.assign({}, r, {
          stock,
          stockText: fmt.qty(stock),
          low: alert > 0 && stock <= alert,
          zero: stock <= 0,
          value: stock * Number(r.price || 0),
        });
      });
      this.setData({ rows }, () => this.applyFilter());

      wx.showToast({
        title: '已调整：' + (res.change > 0 ? '+' : '') + fmt.qty(res.change) + '，结存 ' + fmt.qty(res.after),
        icon: 'none',
        duration: 2200,
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showModal({ title: '调整失败', content: (e && e.message) || '库存调整失败', showCancel: false });
    }
  },
});
