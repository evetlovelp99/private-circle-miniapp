const { ensureAuthed } = require("../../utils/auth");

Page({
  data: {
    members: [],
    loading: true
  },

  async onShow() {
    try {
      await ensureAuthed();
      await this.loadMembers();
    } catch (error) {
      console.error(error);
    }
  },

  async loadMembers() {
    this.setData({ loading: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: "admin",
        data: { action: "listMembers" }
      });
      if (!result?.ok) {
        wx.showToast({ title: result?.message === "only admin allowed" ? "仅创建者可管理成员" : "加载失败", icon: "none" });
        this.setData({ loading: false });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }
      this.setData({ members: result.members || [], loading: false });
    } catch (error) {
      wx.showToast({ title: "加载失败", icon: "none" });
      this.setData({ loading: false });
    }
  },

  silentCutoff(e) {
    const viewerOpenid = e.currentTarget.dataset.openid;
    if (!viewerOpenid) return;
    wx.showModal({
      title: "静默切断",
      content: "对方仍能看到此前的动态，但看不到你以后发的新内容，且不会有任何提示。",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { result } = await wx.cloud.callFunction({
            name: "admin",
            data: { action: "silentCutoff", viewerOpenid }
          });
          if (!result?.ok) throw new Error(result?.message || "操作失败");
          wx.showToast({ title: "已设置" });
          this.loadMembers();
        } catch (err) {
          wx.showToast({ title: err.message || "失败", icon: "none" });
        }
      }
    });
  }
});
