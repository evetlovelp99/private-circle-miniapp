const { ensureAuthed } = require("../../utils/auth");

Page({
  data: {
    postId: "",
    post: null,
    audioUrl: "",
    videoUrl: "",
    videoPosterUrl: "",
    liveMotionUrl: "",
    livePosterUrl: "",
    hasLive: false,
    showVideoOnly: false,
    comments: [],
    content: "",
    canDelete: false
  },

  async onLoad(options) {
    this.setData({ postId: options.id || "" });
    try {
      await ensureAuthed();
      await this.loadDetail();
    } catch (error) {
      console.error(error);
    }
  },

  async loadDetail() {
    wx.showNavigationBarLoading();
    try {
      const [detailRes, sessionRes] = await Promise.all([
        wx.cloud.callFunction({
          name: "post",
          data: { action: "getPostDetail", postId: this.data.postId }
        }),
        wx.cloud.callFunction({
          name: "auth",
          data: { action: "getSession" }
        })
      ]);
      const result = detailRes.result;
      if (!result?.ok || !result.post) {
        wx.showToast({
          title: result?.msg === "no permission" ? "暂无权限查看" : "加载失败",
          icon: "none"
        });
        this.setData({
          post: null,
          comments: [],
          canDelete: false,
          audioUrl: "",
          videoUrl: "",
          videoPosterUrl: "",
          liveMotionUrl: "",
          livePosterUrl: "",
          hasLive: false,
          showVideoOnly: false
        });
        return;
      }

      const post = result.post;
      const images = post.images || [];
      const urlMap = result.mediaUrls || {};

      const hasLive = !!(post.liveMotion && images.length);
      const audioUrl = post.audio ? urlMap[post.audio] || "" : "";
      const videoUrl = post.video ? urlMap[post.video] || "" : "";
      const liveMotionUrl = post.liveMotion ? urlMap[post.liveMotion] || "" : "";
      const videoPosterUrl = post.videoThumb
        ? urlMap[post.videoThumb] || ""
        : hasLive && images[0]
          ? urlMap[images[0]] || ""
          : "";
      const livePosterUrl = hasLive && images[0] ? urlMap[images[0]] || "" : "";
      const showVideoOnly = !!(post.video && !post.liveMotion);

      const openid = sessionRes.result?.openid || "";
      const isAdmin = !!sessionRes.result?.isAdmin;
      const canDelete = !!(post.authorId === openid || isAdmin);

      this.setData({
        post: {
          ...post,
          images: images.map((id) => urlMap[id] || "").filter(Boolean)
        },
        comments: result.comments || [],
        audioUrl,
        videoUrl,
        videoPosterUrl,
        liveMotionUrl,
        livePosterUrl,
        hasLive,
        showVideoOnly,
        canDelete
      });
    } catch (error) {
      wx.showToast({ title: "加载失败", icon: "none" });
    } finally {
      wx.hideNavigationBarLoading();
    }
  },

  onDelete() {
    wx.showModal({
      title: "删除这条动态",
      content: "确定删除吗？对应的点赞与评论会一并删掉。",
      success: async (res) => {
        if (!res.confirm) return;
        try {
          const { result } = await wx.cloud.callFunction({
            name: "post",
            data: { action: "deletePost", postId: this.data.postId }
          });
          if (!result?.ok) throw new Error(result?.msg || "删除失败");
          wx.showToast({ title: "已删除" });
          setTimeout(() => wx.navigateBack(), 300);
        } catch (e) {
          wx.showToast({ title: "删除失败", icon: "none" });
        }
      }
    });
  },

  onInput(e) {
    this.setData({ content: e.detail.value });
  },

  async submitComment() {
    if (!this.data.content.trim()) return;
    try {
      await wx.cloud.callFunction({
        name: "post",
        data: {
          action: "addComment",
          postId: this.data.postId,
          content: this.data.content.trim()
        }
      });
      this.setData({ content: "" });
      this.loadDetail();
    } catch (error) {
      wx.showToast({ title: "评论失败", icon: "none" });
    }
  }
});
