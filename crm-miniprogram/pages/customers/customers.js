const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    loadingMore: false,
    errMsg: '',
    kw: '',
    status: '',
    statuses: [],
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
  },

  onLoad() {
    this.setData({ statuses: api.CUSTOMER_STATUS });
    this.load(true);
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.load(false);
  },

  async load(reset) {
    await auth.guardSession();
    const page = reset ? 1 : this.data.page + 1;
    if (reset) this.setData({ loading: true, errMsg: '' });
    else this.setData({ loadingMore: true });

    try {
      const res = await api.listCustomers({ kw: this.data.kw, status: this.data.status, page });
      const rows = (res.list || []).map((c) => Object.assign({}, c, {
        initial: fmt.initial(c.company_name),
        statusClass: fmt.statusTag(c.status),
        dateText: fmt.dateOnly(c.created_at),
      }));
      const list = reset ? rows : this.data.list.concat(rows);
      this.setData({
        loading: false,
        loadingMore: false,
        list,
        total: res.total,
        page,
        hasMore: list.length < res.total,
      });
    } catch (e) {
      this.setData({
        loading: false,
        loadingMore: false,
        errMsg: (e && e.message) || '客户列表加载失败',
      });
    }
  },

  onSearchInput(e) {
    this.setData({ kw: e.detail.value });
  },

  onSearch() {
    this.load(true);
  },

  onStatusTap(e) {
    const status = e.currentTarget.dataset.status || '';
    this.setData({ status: status === this.data.status ? '' : status });
    this.load(true);
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/customer-detail/customer-detail?id=' + id });
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.phone;
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
});
