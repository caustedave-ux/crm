const api = require('../../utils/api');

Page({
  data: {
    id: 0,
    customer: null,
    contacts: [],
    activities: [],
    loading: true,
    error: '',
  },
  onLoad(options) {
    this.setData({ id: Number(options.id || 0) });
  },
  onShow() {
    if (!api.getToken()) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    this.load();
  },
  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const res = await api.request('GET', '/api/mp/customers/' + this.data.id);
      const c = res.customer;
      this.setData({
        customer: {
          id: c.id,
          company: c.company_name,
          nameEn: c.name_en || '',
          country: c.country || '',
          address: c.address || '',
          website: c.website || '',
          source: c.source || '',
          industry: c.industry || '',
          status: c.status || '',
          level: c.level || '',
          phone: c.phone || '',
          email: c.email || '',
          whatsapp: c.whatsapp || '',
          wechat: c.wechat || '',
          notes: c.notes || '',
        },
        contacts: res.contacts.map(function (t) {
          return {
            id: t.id,
            name: t.name,
            position: t.position || '',
            phone: t.phone || t.mobile || '',
            email: t.email || '',
            primary: !!t.is_primary,
          };
        }),
        activities: res.activities.map(function (a) {
          return {
            id: a.id,
            type: a.type || '跟进',
            subject: a.subject || a.content || '（无内容）',
            person: a.contact_person || '',
            date: (a.activity_date || '').slice(0, 16),
            next: a.next_follow_date ? fmtDate(a.next_follow_date) : '',
          };
        }),
        loading: false,
      });
    } catch (e) {
      this.setData({ error: e.message, loading: false });
    }
  },
  copy(e) {
    const value = e.currentTarget.dataset.value;
    if (!value) return;
    wx.setClipboardData({ data: String(value) });
  },
  call(e) {
    const value = e.currentTarget.dataset.value;
    if (value) wx.makePhoneCall({ phoneNumber: String(value) });
  },
});

function fmtDate(s) {
  return '下次跟进 ' + String(s).slice(0, 10);
}
