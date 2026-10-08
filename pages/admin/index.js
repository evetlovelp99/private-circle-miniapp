const { ensureAuthed } = require("../../utils/auth");

Page({
  data: {
    newCode: "",
    viewerOpenid: ""
  },

  goMembers() {
    wx.navigateTo({ url: "/pages/members/index" });
  },

  async onShow() {
    try {
      await ensureAuthed();
    } catch (error) {
      console.error(error);
    }
  },

  onInputViewer(e) {
    this.setData({ viewerOpenid: e.detail.value.trim() });
  },

  async createInviteCode() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: "admin",
        data: { action: "createInviteCode" }
      });
      this.setData({ newCode: result?.code || "" });
    } catch (error) {
      wx.showToast({ title: "创建失败", icon: "none" });
    }
  },

  async silentCutoff() {
    if (!this.data.viewerOpenid) {
      wx.showToast({ title: "请输入 viewer openid", icon: "none" });
      return;
    }
    try {
      await wx.cloud.callFunction({
        name: "admin",
        data: {
          action: "silentCutoff",
          viewerOpenid: this.data.viewerOpenid
        }
      });
      wx.showToast({ title: "已设置" });
      this.setData({ viewerOpenid: "" });
    } catch (error) {
      wx.showToast({ title: "设置失败", icon: "none" });
    }
  },

  async seedFirstPost() {
    try {
      wx.showLoading({ title: "初始化中" });
      const { result } = await wx.cloud.callFunction({
        name: "admin",
        data: { action: "seedFirstPost" }
      });
      if (!result?.ok) {
        throw new Error(result?.message || "初始化失败");
      }
      wx.showToast({ title: "初始化成功" });
    } catch (error) {
      wx.showToast({ title: error.message || "初始化失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
  }
});
