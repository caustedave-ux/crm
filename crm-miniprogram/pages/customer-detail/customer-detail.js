const api = require('../../utils/api');
const auth = require('../../utils/auth');
const fmt = require('../../utils/format');

const COPYABLE = ['电话', '邮箱', 'WhatsApp', '微信', '联系电话', '手机', '网站'];

Page({
  data: {
    id: 0,
    loading: true,
    errMsg: '',
    customer: null,
    contacts: [],
    activities: [],
    fields: [],
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
      const res = await api.getCustomer(this.data.id);
      const c = res.customer;
      const raw = [
        ['国家/地区', c.country],
        ['行业', c.industry],
        ['客户来源', c.source],
        ['英文名', c.name_en],
        ['地址', c.address],
        ['网站', c.website],
        ['联系人', c.contact_person],
        ['联系电话', c.contact_phone],
        ['电话', c.phone],
        ['邮箱', c.email],
        ['WhatsApp', c.whatsapp],
        ['微信', c.wechat],
        ['税号', c.tax_no],
        ['备注', c.notes],
      ];
      const fields = raw
        .filter((x) => fmt.empty(x[1]))
        .map((x) => ({
          label: x[0],
          value: x[1],
          copyable: COPYABLE.indexOf(x[0]) >= 0,
        }));

      const activities = (res.activities || []).map((a) => Object.assign({}, a, {
        dateText: fmt.dateOnly(a.activity_date || a.created_at),
        nextText: fmt.dateOnly(a.next_follow_date),
      }));

      this.setData({
        loading: false,
        customer: Object.assign({}, c, { statusClass: fmt.statusTag(c.status) }),
        contacts: res.contacts || [],
        activities,
        fields,
      });
      wx.setNavigationBarTitle({ title: c.company_name || '客户详情' });
    } catch (e) {
      this.setData({ loading: false, errMsg: (e && e.message) || '客户加载失败' });
    }
  },

  callPhone(e) {
    const phone = e.currentTarget.dataset.value;
    if (!phone) return;
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },

  copyValue(e) {
    const value = e.currentTarget.dataset.value;
    if (!value) return;
    wx.setClipboardData({ data: String(value) });
  },
});
