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
      if (!result?.ok) throw new Error(result?.msg || "创建失败");
      this.setData({ newCode: result?.code || "" });
    } catch (error) {
      wx.showToast({ title: error.message || "创建失败", icon: "none" });
    }
  },

  async silentCutoff() {
    if (!this.data.viewerOpenid) {
      wx.showToast({ title: "请输入 viewer openid", icon: "none" });
      return;
    }
    try {
      const { result } = await wx.cloud.callFunction({
        name: "admin",
        data: {
          action: "silentCutoff",
          viewerOpenid: this.data.viewerOpenid
        }
      });
      if (!result?.ok) throw new Error(result?.msg || "设置失败");
      wx.showToast({ title: "已设置" });
      this.setData({ viewerOpenid: "" });
    } catch (error) {
      wx.showToast({ title: error.message || "设置失败", icon: "none" });
    }
  }
});
