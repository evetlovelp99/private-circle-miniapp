function ensureAuthed() {
  const app = getApp();
  return new Promise((resolve, reject) => {
    if (app.globalData.user) {
      resolve(app.globalData.user);
      return;
    }
    wx.redirectTo({
      url: "/pages/invite/index"
    });
    reject(new Error("not authed"));
  });
}

function toPostPage(postId) {
  wx.navigateTo({
    url: `/pages/post/index?id=${postId}`
  });
}

module.exports = {
  ensureAuthed,
  toPostPage
};
