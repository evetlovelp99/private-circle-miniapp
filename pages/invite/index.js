Page({
  data: {
    code: "",
    submitting: false,
    canBootstrap: false
  },

  async onShow() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth",
        data: { action: "getSession" }
      });
      this.setData({
        canBootstrap: !!result?.canBootstrap
      });
    } catch (error) {
      console.error("load bootstrap state failed", error);
    }
  },

  onInputCode(e) {
    this.setData({ code: e.detail.value.trim() });
  },

  async submitCode() {
    if (!this.data.code) {
      wx.showToast({ title: "请输入邀请码", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth",
        data: {
          action: "verifyInvite",
          code: this.data.code
        }
      });
      if (!result || !result.ok) {
        throw new Error(result?.msg || "邀请码无效");
      }
      const app = getApp();
      app.globalData.user = result.user;
      app.globalData.openid = result.openid;
      wx.switchTab({ url: "/pages/feed/index" });
    } catch (error) {
      wx.showToast({ title: error.message || "验证失败", icon: "none" });
    } finally {
      this.setData({ submitting: false });
    }
  },

  async bootstrapOwner() {
    this.setData({ submitting: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth",
        data: { action: "bootstrapOwner" }
      });
      if (!result || !result.ok) {
        throw new Error(result?.msg || "创建失败");
      }
      const app = getApp();
      app.globalData.user = result.user;
      app.globalData.openid = result.openid;
      wx.switchTab({ url: "/pages/feed/index" });
    } catch (error) {
      wx.showToast({ title: error.message || "创建失败", icon: "none" });
    } finally {
      this.setData({ submitting: false });
      this.onShow();
    }
  }
});
