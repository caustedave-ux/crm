const api = require('../../utils/api');
const fmt = require('../../utils/fmt');

Page({
  data: {
    userName: '',
    stats: null,
    upcoming: [],
    recentDocs: [],
    loading: true,
    error: '',
  },
  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const user = getApp().globalData.user || wx.getStorageSync('crm_user');
    this.setData({ userName: (user && user.display_name) || user && user.username || '' });
    this.load();
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.request('GET', '/api/mp/overview');
      const upcoming = res.upcoming.map(function (a) {
        return {
          id: a.id,
          customer_id: a.customer_id,
          company: a.company_name,
          type: a.type || '跟进',
          subject: a.subject || a.next_follow_notes || '（无备注）',
          date: fmt.shortDate(a.next_follow_date),
          overdue: a.overdue,
        };
      });
      const recentDocs = res.recentDocs.map(function (d) {
        return {
          id: d.id,
          doc_no: d.doc_no,
          type: fmt.docTypeName(d.doc_type),
          company: d.company_name,
          amount: fmt.money(d.total_amount, d.currency),
          status: d.status,
        };
      });
      this.setData({
        stats: res.stats,
        upcoming: upcoming,
        recentDocs: recentDocs,
        loading: false,
      });
    } catch (e) {
      this.setData({ error: e.message, loading: false });
    }
  },
  goCustomers() { wx.switchTab({ url: '/pages/customers/customers' }); },
  goProducts() { wx.navigateTo({ url: '/pages/products/products' }); },
  goDocuments() { wx.switchTab({ url: '/pages/documents/documents' }); },
  goMore() { wx.switchTab({ url: '/pages/more/more' }); },
  goCustomer(e) {
    wx.navigateTo({ url: '/pages/customer-detail/customer-detail?id=' + e.currentTarget.dataset.id });
  },
});
