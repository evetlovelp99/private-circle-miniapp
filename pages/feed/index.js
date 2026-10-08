const { ensureAuthed, toPostPage } = require("../../utils/auth");
const { formatTime } = require("../../utils/time");

Page({
  data: {
    posts: [],
    openid: "",
    isAdmin: false
  },

  async onShow() {
    try {
      await ensureAuthed();
      const session = await this.refreshSessionFlags();
      await this.loadPosts(session);
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

  async loadPosts(session) {
    wx.showLoading({ title: "加载中" });
    try {
      const { result } = await wx.cloud.callFunction({
        name: "post",
        data: { action: "listPosts" }
      });
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
      this.setData({ posts });
    } catch (error) {
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      wx.hideLoading();
    }
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
          this.loadPosts();
        } catch (err) {
          wx.showToast({
            title: err.message === "no permission" ? "无权限删除" : "删除失败",
            icon: "none"
          });
        }
      }
    });
  },

  async onLikeTap(e) {
    const postId = e.currentTarget.dataset.id;
    try {
      await wx.cloud.callFunction({
        name: "post",
        data: { action: "toggleLike", postId }
      });
      this.loadPosts();
    } catch (error) {
      wx.showToast({ title: "操作失败", icon: "none" });
    }
  },

  goPost(e) {
    const postId = e.currentTarget.dataset.id;
    toPostPage(postId);
  }
});
