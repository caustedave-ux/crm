// ============ 网络请求封装 ============
const { BASE_URL } = require('./config');

function getToken() {
  return wx.getStorageSync('crm_token') || '';
}
function setToken(token) {
  wx.setStorageSync('crm_token', token);
}
function clearToken() {
  wx.removeStorageSync('crm_token');
}

// 统一请求：自动附带 Bearer Token；401 时清除凭据并跳转登录页
function request(method, path, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: BASE_URL + path,
      method: method,
      data: data,
      header: { 'Authorization': 'Bearer ' + getToken() },
      success(res) {
        if (res.statusCode === 401) {
          clearToken();
          wx.removeStorageSync('crm_user');
          wx.reLaunch({ url: '/pages/login/login' });
          reject(new Error('未登录或登录已过期'));
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data);
        } else {
          reject(new Error((res.data && res.data.error) || ('请求失败（' + res.statusCode + '）')));
        }
      },
      fail() {
        reject(new Error('网络连接失败，请检查服务地址与网络'));
      },
    });
  });
}

module.exports = { request, getToken, setToken, clearToken };
