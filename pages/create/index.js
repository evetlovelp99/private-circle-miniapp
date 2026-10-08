const { ensureAuthed } = require("../../utils/auth");

Page({
  data: {
    text: "",
    images: [],
    submitting: false,
    recording: false,
    audioTempPath: "",
    videoTempPath: "",
    videoThumbTempPath: "",
    videoDurationSec: 0,
    liveCoverTempPath: "",
    liveMotionTempPath: ""
  },

  async onShow() {
    try {
      await ensureAuthed();
    } catch (error) {
      console.error(error);
    }
  },

  onLoad() {
    const rm = wx.getRecorderManager();
    this._rm = rm;
    rm.onStop((res) => {
      if (this._discardStop) {
        this._discardStop = false;
        this.setData({ recording: false });
        return;
      }
      const duration = typeof res.duration === "number" ? res.duration : 0;
      this.setData({ recording: false });
      const path = res.tempFilePath || "";
      if (!path || duration < 700) {
        wx.showToast({ title: duration < 700 ? "按住时间太短" : "未录到音频", icon: "none" });
        return;
      }
      this.setData({ audioTempPath: path });
    });
    rm.onError(() => {
      wx.showToast({ title: "录音失败", icon: "none" });
      this.setData({ recording: false });
    });
  },

  startRecord() {
    if (!this._rm) return;
    if (this.data.recording) return;
    this._discardStop = false;
    const begin = () => {
      try {
        this._rm.start({
          duration: 60000,
          format: "aac"
        });
        this.setData({ recording: true });
      } catch (e) {
        wx.showToast({ title: "无法开始录音", icon: "none" });
      }
    };
    wx.getSetting({
      success: (setting) => {
        if (setting.authSetting["scope.record"]) {
          begin();
          return;
        }
        wx.authorize({
          scope: "scope.record",
          success: begin,
          fail: () =>
            wx.showModal({
              title: "需要麦克风权限",
              content: "请在设置中开启录音权限以发布语音。",
              confirmText: "去设置",
              success: (modal) => modal.confirm && wx.openSetting()
            })
        });
      }
    });
  },

  stopRecord() {
    if (!this._rm || !this.data.recording) return;
    this._rm.stop();
  },

  discardAudio() {
    if (this.data.recording) {
      this._discardStop = true;
      this._rm.stop();
    }
    this.setData({ audioTempPath: "", recording: false });
  },

  onTextInput(e) {
    this.setData({ text: e.detail.value });
  },

  chooseImages() {
    const remain = 9 - this.data.images.length;
    if (remain <= 0) return;
    wx.chooseMedia({
      count: remain,
      mediaType: ["image"],
      sizeType: ["original"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const files = res.tempFiles.map((f) => f.tempFilePath);
        this.setData({
          images: this.data.images.concat(files).slice(0, 9),
          ...this.clearVideoAndLivePayload()
        });
      }
    });
  },

  clearVideoAndLivePayload() {
    return {
      videoTempPath: "",
      videoThumbTempPath: "",
      videoDurationSec: 0,
      liveCoverTempPath: "",
      liveMotionTempPath: ""
    };
  },

  chooseVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["video"],
      maxDuration: 300,
      sourceType: ["album", "camera"],
      success: (res) => {
        const f = res.tempFiles[0];
        if (!f || !f.tempFilePath) return;
        this.setData({
          videoTempPath: f.tempFilePath,
          videoThumbTempPath: f.thumbTempFilePath || "",
          videoDurationSec: Math.round((f.duration || 0) / 1000) || 0,
          images: [],
          liveCoverTempPath: "",
          liveMotionTempPath: "",
          audioTempPath: ""
        });
      }
    });
  },

  chooseLiveCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["image"],
      sizeType: ["original"],
      sourceType: ["album", "camera"],
      success: (res) => {
        const p = res.tempFiles[0]?.tempFilePath;
        if (!p) return;
        this.setData({
          liveCoverTempPath: p,
          images: [],
          videoTempPath: "",
          videoThumbTempPath: "",
          videoDurationSec: 0,
          audioTempPath: ""
        });
      }
    });
  },

  chooseLiveMotion() {
    wx.chooseMedia({
      count: 1,
      mediaType: ["video"],
      maxDuration: 60,
      sourceType: ["album", "camera"],
      success: (res) => {
        const f = res.tempFiles[0];
        if (!f || !f.tempFilePath) return;
        this.setData({
          liveMotionTempPath: f.tempFilePath,
          images: [],
          videoTempPath: "",
          videoThumbTempPath: "",
          videoDurationSec: 0,
          audioTempPath: ""
        });
      }
    });
  },

  discardVideo() {
    this.setData({
      videoTempPath: "",
      videoThumbTempPath: "",
      videoDurationSec: 0
    });
  },

  discardLive() {
    this.setData({
      liveCoverTempPath: "",
      liveMotionTempPath: ""
    });
  },

  async uploadOne(path, cloudBase, ext) {
    const cloudPath = `posts/${cloudBase}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}.${ext}`;
    const { fileID } = await wx.cloud.uploadFile({
      cloudPath,
      filePath: path
    });
    return fileID;
  },

  async uploadImages() {
    const paths = this.data.images || [];
    if (!paths.length) return [];
    const tasks = paths.map((path, index) =>
      this.uploadOne(path, "img", "jpg").then((id) => id)
    );
    return Promise.all(tasks);
  },

  async uploadAudio() {
    const path = this.data.audioTempPath;
    if (!path) return "";
    return this.uploadOne(path, "audio", "aac");
  },

  async uploadVideoBundle() {
    const vPath = this.data.videoTempPath;
    if (!vPath) return { videoFileId: "", videoThumbFileId: "" };
    const thumbPath = this.data.videoThumbTempPath;
    const videoFileId = await this.uploadOne(vPath, "video", "mp4");
    let videoThumbFileId = "";
    if (thumbPath) {
      try {
        videoThumbFileId = await this.uploadOne(thumbPath, "vthumb", "jpg");
      } catch (e) {
        console.error(e);
      }
    }
    return { videoFileId, videoThumbFileId };
  },

  async uploadLivePair() {
    const cover = this.data.liveCoverTempPath;
    const motion = this.data.liveMotionTempPath;
    if (!cover || !motion) {
      return { images: [], liveMotionFileId: "" };
    }
    const [coverId, motionId] = await Promise.all([
      this.uploadOne(cover, "live_cover", "jpg"),
      this.uploadOne(motion, "live_motion", "mp4")
    ]);
    return {
      images: [coverId],
      liveMotionFileId: motionId
    };
  },

  resetDraft() {
    this.setData({
      text: "",
      images: [],
      audioTempPath: "",
      videoTempPath: "",
      videoThumbTempPath: "",
      videoDurationSec: 0,
      liveCoverTempPath: "",
      liveMotionTempPath: ""
    });
  },

  async submitPost() {
    const hasText = !!this.data.text.trim();
    const hasGallery = this.data.images.length > 0;
    const hasVoice = !!this.data.audioTempPath;
    const hasPlainVideo = !!this.data.videoTempPath;
    const hasLiveCover = !!this.data.liveCoverTempPath;
    const hasLiveMotion = !!this.data.liveMotionTempPath;
    const hasLive = hasLiveCover && hasLiveMotion;

    if (hasLiveCover && !hasLiveMotion) {
      wx.showToast({ title: "请再选实况动态视频", icon: "none" });
      return;
    }
    if (!hasLiveCover && hasLiveMotion) {
      wx.showToast({ title: "请先选实况封面图", icon: "none" });
      return;
    }

    if (!hasText && !hasGallery && !hasVoice && !hasPlainVideo && !hasLive) {
      wx.showToast({ title: "请添加文字 / 图 / 语音 / 视频 / 实况", icon: "none" });
      return;
    }
    if (this.data.recording) {
      wx.showToast({ title: "请先结束录音", icon: "none" });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: "上传中" });
    try {
      let imageFileIds = [];
      let videoFileId = "";
      let videoThumbFileId = "";
      let liveMotionFileId = "";
      let audioFileId = "";

      if (hasLive) {
        const live = await this.uploadLivePair();
        imageFileIds = live.images;
        liveMotionFileId = live.liveMotionFileId;
        audioFileId = await this.uploadAudio();
      } else {
        const [imgs, vid, audio] = await Promise.all([
          this.uploadImages(),
          this.uploadVideoBundle(),
          this.uploadAudio()
        ]);
        imageFileIds = imgs;
        videoFileId = vid.videoFileId;
        videoThumbFileId = vid.videoThumbFileId;
        audioFileId = audio;
      }

      const { result } = await wx.cloud.callFunction({
        name: "post",
        data: {
          action: "createPost",
          text: this.data.text.trim(),
          images: imageFileIds,
          audioFileId: audioFileId || "",
          videoFileId: videoFileId || "",
          videoThumbFileId: videoThumbFileId || "",
          liveMotionFileId: liveMotionFileId || ""
        }
      });
      if (!result?.ok) {
        throw new Error(result?.msg || "失败");
      }
      wx.showToast({ title: "发布成功" });
      this.resetDraft();
      wx.switchTab({ url: "/pages/feed/index" });
    } catch (error) {
      console.error(error);
      wx.showToast({ title: "发布失败，请稍后重试", icon: "none" });
    } finally {
      this.setData({ submitting: false });
      wx.hideLoading();
    }
  }
});
