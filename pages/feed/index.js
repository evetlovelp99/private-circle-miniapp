const { ensureAuthed, toPostPage } = require("../../utils/auth");
const { formatTime } = require("../../utils/time");

Page({
  data: {
    posts: [],
    currentUser: null,
    openid: "",
    isAdmin: false,
    loading: false,
    hasMore: true,
    nextCursor: null,
    memberCount: "–",
    todayPostCount: "–"
  },
  previewImage(e) {
    const { urls, current } = e.currentTarget.dataset;
    wx.previewImage({ current, urls });
  },

  async onShow() {
    try {
      const user = await ensureAuthed();
      this.setData({ currentUser: user });
      const session = await this.refreshSessionFlags();
      await Promise.all([this.loadPosts(session), this.loadStats()]);
    } catch (error) {
      console.error(error);
    }
  },

  async refreshSessionFlags() {
    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth",
        data: { action: "getSession" }
      });
      const session = {
        openid: result?.openid || "",
        isAdmin: !!result?.isAdmin
      };
      this.setData(session);
      return session;
    } catch (error) {
      console.error(error);
      return { openid: "", isAdmin: false };
    }
  },

  async onPullDownRefresh() {
    try { await Promise.all([this.loadPosts(), this.loadStats()]); } finally { wx.stopPullDownRefresh(); }
  },

  async loadStats() {
    const request = (this.statsRequest || 0) + 1;
    this.statsRequest = request;
    this.setData({ memberCount: "–", todayPostCount: "–" });
    const now = new Date();
    const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    const dayStart = new Date(y, m, d).getTime();
    const dayEnd = new Date(y, m, d + 1).getTime();
    try {
      const { result } = await wx.cloud.callFunction({
        name: "auth", data: { action: "getStats", dayStart, dayEnd }
      });
      if (!result?.ok || !Number.isInteger(result.memberCount) || result.memberCount < 1 ||
          !Number.isInteger(result.todayPostCount) || result.todayPostCount < 0) {
        throw new Error(result?.msg || "统计加载失败");
      }
      if (this.statsRequest === request) this.setData({
        memberCount: result.memberCount, todayPostCount: result.todayPostCount
      });
    } catch (error) {
      if (this.statsRequest === request) this.setData({ memberCount: "--", todayPostCount: "--" });
    }
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) this.loadPosts(null, true);
  },

  async loadPosts(session, append = false) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: "加载中" });
    try {
      const { result } = await wx.cloud.callFunction({
        name: "post",
        data: { action: "listPosts", ...(append ? this.data.nextCursor || {} : {}) }
      });
      if (!result?.ok) throw new Error(result?.msg || "加载失败");
      const raw = result?.data || [];
      const urlMap = result?.mediaUrls || {};
      const openid = session?.openid ?? this.data.openid;
      const isAdmin = !!(session?.isAdmin ?? this.data.isAdmin);
      const posts = raw.map((item) => {
        const images = item.images || [];
        const hasLive = !!(item.liveMotion && images.length);
        const audioUrl = item.audio ? urlMap[item.audio] || "" : "";
        const videoUrl = item.video ? urlMap[item.video] || "" : "";
        const liveMotionUrl = item.liveMotion ? urlMap[item.liveMotion] || "" : "";
        const videoPosterUrl = item.videoThumb
          ? urlMap[item.videoThumb] || ""
          : hasLive && images[0]
            ? urlMap[images[0]] || ""
            : "";
        const livePosterUrl = hasLive && images[0] ? urlMap[images[0]] || "" : "";
        return {
          ...item,
          images: images.map((id) => urlMap[id] || "").filter(Boolean),
          audioUrl,
          videoUrl,
          videoPosterUrl,
          liveMotionUrl,
          livePosterUrl,
          hasLive,
          showVideoOnly: !!(item.video && !item.liveMotion),
          formattedTime: formatTime(item.createdAt),
          _canDelete: !!(item.authorId === openid || isAdmin)
        };
      });
      const combined = append ? this.data.posts.concat(posts) : posts;
      const seen = new Set();
      this.setData({ posts: combined.filter((post) => {
        if (seen.has(post._id)) return false;
        seen.add(post._id);
        return true;
      }), hasMore: !!result.hasMore, nextCursor: result.nextCursor || null });
    } catch (error) {
      wx.showToast({ title: error.message || "加载失败", icon: "none" });
    } finally {
      this.setData({ loading: false });
      wx.hideLoading();
    }
  },

  onPostMenu(e) {
    const postId = e.currentTarget.dataset.id;
    const post = this.data.posts.find((item) => item._id === postId);
    if (!post || !post._canDelete) return;
    wx.showActionSheet({
      itemList: ["删除"],
      success: (res) => { if (res.tapIndex === 0) this.onDeletePost(e); }
    });
  },

  async onDeletePost(e) {
    const postId = e.currentTarget.dataset.id;
    if (!postId) return;
    wx.showModal({
      title: "删除这条动态",
      content: "确定删除吗？对应的点赞与评论会一并删掉。",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { result } = await wx.cloud.callFunction({
            name: "post",
            data: { action: "deletePost", postId }
          });
          if (!result?.ok) {
            throw new Error(result?.msg || "删除失败");
          }
          wx.showToast({ title: "已删除" });
          await Promise.all([this.loadPosts(), this.loadStats()]);
        } catch (err) {
          wx.showToast({
            title: err.message || "删除失败",
            icon: "none"
          });
        }
      }
    });
  },

  async onLikeTap(e) {
    const postId = e.currentTarget.dataset.id;
    try {
      const { result } = await wx.cloud.callFunction({
        name: "post",
        data: { action: "toggleLike", postId }
      });
      if (!result?.ok) throw new Error(result?.msg || "操作失败");
      this.loadPosts();
    } catch (error) {
      wx.showToast({ title: error.message || "操作失败", icon: "none" });
    }
  },

  goPost(e) {
    const postId = e.currentTarget.dataset.id;
    toPostPage(postId);
  }
});
