App({
  globalData: {
    user: null,
    openid: "",
    envId: "cloud1-d6gd059tx755c0ffd"
  },

  async onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: "提示",
        content: "请使用支持云开发的基础库版本"
      });
      return;
    }

    wx.cloud.init({
      env: this.globalData.envId,
      traceUser: true
    });

    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth",
        data: { action: "getSession" }
      });
      if (result && result.ok) {
        this.globalData.user = result.user || null;
        this.globalData.openid = result.openid || "";
      }
    } catch (error) {
      console.error("init session failed", error);
    }
  }
});
