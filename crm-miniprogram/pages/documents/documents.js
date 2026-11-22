const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    loading: true,
    loadingMore: false,
    errMsg: '',
    kw: '',
    type: '',
    types: [],
    list: [],
    total: 0,
    page: 1,
    hasMore: false,
  },

  onLoad() {
    this.setData({ types: api.DOC_TYPES });
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
      const res = await api.listDocuments({ kw: this.data.kw, type: this.data.type, page });
      const rows = (res.list || []).map((d) => Object.assign({}, d, {
        amountText: fmt.amount(d.total_amount),
        typeName: api.docTypeName(d.doc_type),
        dateText: fmt.dateOnly(d.issue_date || d.created_at),
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
        errMsg: (e && e.message) || '单据列表加载失败',
      });
    }
  },

  onSearchInput(e) {
    this.setData({ kw: e.detail.value });
  },

  onSearch() {
    this.load(true);
  },

  onTypeTap(e) {
    const type = e.currentTarget.dataset.type || '';
    this.setData({ type: type === this.data.type ? '' : type });
    this.load(true);
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pages/document-detail/document-detail?id=' + id });
  },
});
