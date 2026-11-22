const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    errMsg: '',
    stats: { totalCustomers: 0, newCustomersMonth: 0, docMonth: 0, docMonthAmount: 0, lowStock: 0, productCount: 0 },
    amountText: '0.00',
    upcoming: [],
    recentDocs: [],
  },

  onLoad() {
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    await auth.guardSession();
    this.setData({ errMsg: '' });
    try {
      const data = await api.getOverview();
      const upcoming = (data.upcoming || []).map((a) => Object.assign({}, a, {
        dateText: fmt.dateOnly(a.next_follow_date),
      }));
      const recentDocs = (data.recentDocs || []).map((d) => Object.assign({}, d, {
        amountText: fmt.amount(d.total_amount),
        typeName: api.docTypeName(d.doc_type),
        dateText: fmt.dateOnly(d.issue_date || d.created_at),
      }));
      this.setData({
        loading: false,
        stats: data.stats,
        amountText: fmt.amount(data.stats.docMonthAmount),
        upcoming,
        recentDocs,
      });
    } catch (e) {
      this.setData({ loading: false, errMsg: (e && e.message) || '数据加载失败' });
    }
  },

  goProducts() {
    wx.navigateTo({ url: '/pages/products/products' });
  },

  goStock() {
    wx.navigateTo({ url: '/pages/stock/stock' });
  },

  goCustomer(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/customer-detail/customer-detail?id=' + id });
  },

  goDocument(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/document-detail/document-detail?id=' + id });
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});
