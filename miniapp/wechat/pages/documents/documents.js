const api = require('../../utils/api');
const fmt = require('../../utils/fmt');

const FILTERS = [{ key: '', name: '全部' }].concat(fmt.DOC_TYPES);

Page({
  data: {
    filters: FILTERS,
    activeType: '',
    kw: '',
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
    loading: false,
    error: '',
  },
  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.reload();
  },
  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh());
  },
  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadPage(this.data.page + 1);
  },
  mapItem(d) {
    return {
      id: d.id,
      doc_no: d.doc_no,
      type: fmt.docTypeName(d.doc_type),
      company: d.company_name,
      amount: fmt.money(d.total_amount, d.currency),
      status: d.status || '',
      date: fmt.shortDate(d.issue_date || d.created_at),
      void: d.status === '已作废',
    };
  },
  statusClass(status) {
    if (status === '已确认' || status === '已完成') return 'tag-green';
    if (status === '已作废') return 'tag-red';
    if (status === '草稿') return 'tag-gray';
    return 'tag-orange';
  },
  async reload() {
    return this.loadPage(1);
  },
  async loadPage(page) {
    this.setData({ loading: true, error: '' });
    try {
      let url = '/api/mp/documents?page=' + page;
      if (this.data.kw) url += '&kw=' + encodeURIComponent(this.data.kw);
      if (this.data.activeType) url += '&type=' + this.data.activeType;
      const res = await api.request('GET', url);
      const self = this;
      const items = res.list.map(function (d) {
        const item = self.mapItem(d);
        item.statusClass = self.statusClass(d.status);
        return item;
      });
      const list = page === 1 ? items : this.data.list.concat(items);
      this.setData({ list: list, total: res.total, page: page, hasMore: list.length < res.total, loading: false });
    } catch (e) {
      this.setData({ error: e.message, loading: false });
    }
  },
  onFilter(e) {
    this.setData({ activeType: e.currentTarget.dataset.key });
    this.reload();
  },
  onSearch(e) {
    this.setData({ kw: e.detail.value });
  },
  onSearchConfirm() {
    this.reload();
  },
});
