const { ensureAuthed } = require("../../utils/auth");

Page({
  data: {
    user: null,
    openid: "",
    displayOpenid: "",
    nicknameSheetOpen: false,
    nicknameDraft: "",
    savingNickname: false
  },

  async onShow() {
    this.setNicknameTabBarHidden(false);
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar && tabBar.syncSelection) tabBar.syncSelection();
    try {
      const user = await ensureAuthed();
      const app = getApp();
      this.setData({
        user,
        openid: app.globalData.openid,
        displayOpenid: app.globalData.openid
          ? `${app.globalData.openid.slice(0, 8)}…${app.globalData.openid.slice(-6)}`
          : ""
      });
    } catch (error) {
      console.error(error);
    }
  },

  onHide() {
    this.dismissNicknameSheet();
  },

  setNicknameTabBarHidden(hidden) {
    const tabBar = this.getTabBar && this.getTabBar();
    if (tabBar && tabBar.setData) tabBar.setData({ hidden });
  },

  openNicknameSheet() {
    this.finishNicknameReviewWait(false);
    this._nicknameSession = (this._nicknameSession || 0) + 1;
    this._nicknameReviewState = "idle";
    try {
      this._supportsNicknameReview = typeof wx.canIUse === "function" && wx.canIUse("input.bindnicknamereview");
    } catch (error) {
      this._supportsNicknameReview = false;
    }
    this.setData({ nicknameSheetOpen: true, nicknameDraft: this.data.user?.nickname || "" });
    this.setNicknameTabBarHidden(true);
  },

  dismissNicknameSheet() {
    this.finishNicknameReviewWait(false);
    this._nicknameSession = (this._nicknameSession || 0) + 1;
    this._nicknameReviewState = "idle";
    this.setData({ nicknameSheetOpen: false });
    this.setNicknameTabBarHidden(false);
  },

  closeNicknameSheet() {
    if (this.data.savingNickname) return;
    this.dismissNicknameSheet();
  },

  keepSheetOpen() {},

  updateNicknameDraft(value) {
    if (value !== this.data.nicknameDraft) {
      this.finishNicknameReviewWait(false);
      this._nicknameReviewState = "pending";
      this.setData({ nicknameDraft: value });
    }
  },

  onNicknameInput(e) {
    this.updateNicknameDraft(e.detail.value);
  },

  onNicknameBlur(e) {
    // WeChat nickname selection may deliver its final value only on blur.
    this.updateNicknameDraft(e.detail.value);
  },

  onNicknameReview(e) {
    if (!this.data.nicknameSheetOpen) return;
    if (e.detail.pass === false) {
      this._nicknameReviewState = "failed";
      this.finishNicknameReviewWait(false);
      wx.showToast({ title: "这个名字没通过微信检测，换一个吧", icon: "none" });
    } else if (e.detail.pass === true && this._nicknameReviewState !== "failed") {
      // An explicit failure stays blocked until the user changes the value.
      this._nicknameReviewState = "passed";
      this.finishNicknameReviewWait(true);
    }
  },

  finishNicknameReviewWait(allowed) {
    const wait = this._nicknameReviewWait;
    if (!wait) return;
    this._nicknameReviewWait = null;
    clearTimeout(wait.timer);
    wait.resolve(allowed);
  },

  waitForNicknameReview() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._nicknameReviewState !== "failed") this._nicknameReviewState = "timeout";
        this.finishNicknameReviewWait(this._nicknameReviewState !== "failed");
      }, 3000);
      this._nicknameReviewWait = { resolve, timer };
    });
  },

  async saveNickname(e) {
    if (this.data.savingNickname || this._nicknameReviewWait || !this.data.nicknameSheetOpen) return;
    // Form submission captures the input even if blur has not run yet.
    const nickname = typeof e?.detail?.value?.nickname === "string"
      ? e.detail.value.nickname : this.data.nicknameDraft;
    this.updateNicknameDraft(nickname);
    if (nickname === this.data.user?.nickname) {
      this.dismissNicknameSheet();
      return;
    }
    if (this._nicknameReviewState === "failed") {
      wx.showToast({ title: "这个名字没通过微信检测，换一个吧", icon: "none" });
      return;
    }
    const session = this._nicknameSession;
    if (this._supportsNicknameReview && this._nicknameReviewState === "pending") {
      const allowed = await this.waitForNicknameReview();
      if (!allowed || session !== this._nicknameSession || !this.data.nicknameSheetOpen || nickname !== this.data.nicknameDraft) return;
    }
    if (this._nicknameReviewState === "failed") return;
    this.setData({ savingNickname: true });
    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth",
        data: { action: "updateNickname", nickname }
      });
      // Cloud validation is authoritative, including Unicode character counts.
      if (!result?.ok || !result.user) throw new Error(result?.msg || "改名失败，请重试");
      getApp().globalData.user = result.user;
      if (session === this._nicknameSession) {
        this.setData({ user: result.user, nicknameDraft: result.user.nickname });
        this.dismissNicknameSheet();
        wx.showToast({ title: "已改名", icon: "success" });
      }
    } catch (error) {
      if (session === this._nicknameSession) wx.showToast({ title: error.message || "改名失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ savingNickname: false });
    }
  },

  goAdmin() {
    wx.navigateTo({ url: "/pages/admin/index" });
  }
});
