const { ensureAuthed } = require("../../utils/auth");

Page({
  data: {
    user: null,
    openid: ""
  },

  async onShow() {
    try {
      const user = await ensureAuthed();
      const app = getApp();
      this.setData({
        user,
        openid: app.globalData.openid
      });
    } catch (error) {
      console.error(error);
    }
  },

  goAdmin() {
    wx.navigateTo({ url: "/pages/admin/index" });
  }
});
