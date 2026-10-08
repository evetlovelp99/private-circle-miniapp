const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function getRelationsMap(viewerOpenid) {
  const relRes = await db.collection("relations").where({
    viewerUserId: viewerOpenid
  }).get();
  return relRes.data.reduce((acc, r) => {
    acc[r.ownerUserId] = r.canViewUntil || null;
    return acc;
  }, {});
}

async function getUsersMap(openids) {
  if (!openids.length) return {};
  const userRes = await db.collection("users").where({
    openid: _.in(openids)
  }).get();
  return userRes.data.reduce((acc, u) => {
    acc[u.openid] = u;
    return acc;
  }, {});
}

async function canViewPost(post, viewerOpenid) {
  if (!post) return false;
  if (post.authorId === viewerOpenid) return true;
  const relRes = await db.collection("relations").where({
    ownerUserId: post.authorId,
    viewerUserId: viewerOpenid
  }).limit(1).get();
  if (!relRes.data.length) return false;
  const relation = relRes.data[0];
  if (!relation.canViewUntil) return true;
  return post.createdAt <= relation.canViewUntil;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  if (action === "createPost") {
    const post = {
      authorId: OPENID,
      text: event.text || "",
      images: event.images || [],
      audio: event.audioFileId || "",
      video: event.videoFileId || "",
      videoThumb: event.videoThumbFileId || "",
      liveMotion: event.liveMotionFileId || "",
      createdAt: new Date().toISOString()
    };
    const added = await db.collection("posts").add({ data: post });
    return { ok: true, id: added._id };
  }

  if (action === "listPosts") {
    const relationsMap = await getRelationsMap(OPENID);
    const authorOpenids = [...new Set(Object.keys(relationsMap).concat([OPENID]))];
    const postRes = await db.collection("posts").where({
      authorId: _.in(authorOpenids)
    }).orderBy("createdAt", "desc").limit(50).get();
    const posts = postRes.data.filter((post) => {
      if (post.authorId === OPENID) return true;
      const canViewUntil = relationsMap[post.authorId];
      if (canViewUntil === undefined) return false;
      if (!canViewUntil) return true;
      return post.createdAt <= canViewUntil;
    });
    const postIds = posts.map((p) => p._id);
    const usersMap = await getUsersMap(authorOpenids);

    let likes = [];
    let comments = [];
    if (postIds.length) {
      const likeRes = await db.collection("likes").where({ postId: _.in(postIds) }).get();
      const commentRes = await db.collection("comments").where({ postId: _.in(postIds) }).get();
      likes = likeRes.data;
      comments = commentRes.data;
    }

    const data = posts.map((post) => {
      const postLikes = likes.filter((l) => l.postId === post._id);
      const postComments = comments.filter((c) => c.postId === post._id);
      return {
        ...post,
        author: usersMap[post.authorId] || {},
        likeCount: postLikes.length,
        commentCount: postComments.length,
        liked: postLikes.some((l) => l.userId === OPENID)
      };
    });
    return { ok: true, data };
  }

  if (action === "deletePost") {
    const postId = event.postId;
    const docRes = await db.collection("posts").doc(postId).get();
    const post = docRes.data;
    if (!post) {
      return { ok: false, message: "not found" };
    }
    const isAuthor = post.authorId === OPENID;
    const isAdmin = !!process.env.OWNER_OPENID && OPENID === process.env.OWNER_OPENID;
    if (!isAuthor && !isAdmin) {
      return { ok: false, message: "no permission" };
    }

    const likeBatch = await db.collection("likes").where({ postId }).get();
    for (const l of likeBatch.data) {
      await db.collection("likes").doc(l._id).remove();
    }
    const commentBatch = await db.collection("comments").where({ postId }).get();
    for (const c of commentBatch.data) {
      await db.collection("comments").doc(c._id).remove();
    }
    await db.collection("posts").doc(postId).remove();
    return { ok: true };
  }

  if (action === "toggleLike") {
    const postId = event.postId;
    const postRes = await db.collection("posts").doc(postId).get();
    if (!(await canViewPost(postRes.data, OPENID))) {
      return { ok: false, message: "no permission" };
    }
    const exist = await db.collection("likes").where({
      postId,
      userId: OPENID
    }).limit(1).get();
    if (exist.data.length) {
      await db.collection("likes").doc(exist.data[0]._id).remove();
      return { ok: true, liked: false };
    }
    await db.collection("likes").add({
      data: {
        postId,
        userId: OPENID,
        createdAt: new Date().toISOString()
      }
    });
    return { ok: true, liked: true };
  }

  if (action === "getPostDetail") {
    const postId = event.postId;
    const postRes = await db.collection("posts").doc(postId).get();
    const post = postRes.data;
    if (!(await canViewPost(post, OPENID))) {
      return { ok: false, message: "no permission" };
    }
    const userRes = await db.collection("users").where({ openid: post.authorId }).limit(1).get();
    const commentsRes = await db.collection("comments").where({ postId }).orderBy("createdAt", "asc").get();
    const commenters = [...new Set(commentsRes.data.map((c) => c.userId))];
    const usersMap = await getUsersMap(commenters);
    const comments = commentsRes.data.map((c) => ({
      ...c,
      user: usersMap[c.userId] || {}
    }));
    return {
      ok: true,
      post: {
        ...post,
        author: userRes.data[0] || {}
      },
      comments
    };
  }

  if (action === "addComment") {
    const postRes = await db.collection("posts").doc(event.postId).get();
    if (!(await canViewPost(postRes.data, OPENID))) {
      return { ok: false, message: "no permission" };
    }
    await db.collection("comments").add({
      data: {
        postId: event.postId,
        userId: OPENID,
        content: event.content || "",
        createdAt: new Date().toISOString()
      }
    });
    return { ok: true };
  }

  return { ok: false, message: "unknown action" };
};
