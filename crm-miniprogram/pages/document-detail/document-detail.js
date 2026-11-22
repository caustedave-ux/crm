const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

Page({
  data: {
    id: 0,
    loading: true,
    errMsg: '',
    doc: null,
    items: [],
    fields: [],
    totalText: '0.00',
    subtotalText: '0.00',
  },

  onLoad(options) {
    this.setData({ id: Number(options.id) || 0 });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    await auth.guardSession();
    this.setData({ errMsg: '' });
    try {
      const res = await api.getDocument(this.data.id);
      const d = res.document;

      const items = (res.items || []).map((it) => Object.assign({}, it, {
        priceText: fmt.amount(it.price),
        amountText: fmt.amount(it.amount),
        qtyText: (it.qty === undefined || it.qty === null ? '' : it.qty) + (it.unit ? ' ' + it.unit : ''),
      }));

      const raw = [
        ['客户', d.company_name],
        ['单据类型', api.docTypeName(d.doc_type)],
        ['标题', d.title],
        ['付款条款', d.payment_terms],
        ['贸易条款', d.trade_terms],
        ['装运港', d.port_loading],
        ['目的港', d.port_destination],
        ['交货期', fmt.dateOnly(d.delivery_date)],
        ['有效期至', fmt.dateOnly(d.valid_until)],
        ['唛头', d.shipping_marks],
        ['备注', d.remarks],
      ];
      const fields = raw.filter((x) => fmt.empty(x[1])).map((x) => ({ label: x[0], value: x[1] }));

      this.setData({
        loading: false,
        doc: Object.assign({}, d, { issueText: fmt.dateOnly(d.issue_date || d.created_at) }),
        items,
        fields,
        totalText: fmt.amount(d.total_amount),
        subtotalText: fmt.amount(d.subtotal),
      });
      wx.setNavigationBarTitle({ title: d.doc_no || '单据详情' });
    } catch (e) {
      this.setData({ loading: false, errMsg: (e && e.message) || '单据加载失败' });
    }
  },

  goCustomer() {
    const id = this.data.doc && this.data.doc.customer_id;
    if (id) wx.navigateTo({ url: '/pages/customer-detail/customer-detail?id=' + id });
  },
});
