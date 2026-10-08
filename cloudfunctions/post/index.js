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

function collectFileIDs(post) {
  return [...new Set([...(post.images || []), post.audio, post.video, post.videoThumb, post.liveMotion].filter(isFileID))];
}

async function resolveMedia(posts) {
  const ids = [...new Set(posts.flatMap(collectFileIDs))];
  const mediaUrls = {};
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const result = await cloud.getTempFileURL({ fileList: ids.slice(i, i + 50) });
      for (const item of result.fileList || []) {
        if (item.status === 0 && item.tempFileURL) mediaUrls[item.fileID] = item.tempFileURL;
      }
    } catch (error) {
      console.error("resolve media failed", error);
    }
  }
  return mediaUrls;
}

function isOwner(openid) {
  return !!process.env.OWNER_OPENID && openid === process.env.OWNER_OPENID;
}

async function isMember(openid) {
  if (isOwner(openid)) return true;
  if (!process.env.OWNER_OPENID) return false;
  const users = await db.collection("users").where({ openid }).limit(1).get();
  const relations = await db.collection("relations").where({
    ownerUserId: process.env.OWNER_OPENID, viewerUserId: openid
  }).limit(1).get();
  return !!users.data.length && !!relations.data.length;
}

function isFileID(value) {
  return typeof value === "string" && /^cloud:\/\/[^/\s]+\/[^\s]+$/.test(value);
}

function validatePost(event) {
  if (typeof event.text !== "string" || event.text.length > 1000) return "文字必须为不超过1000字的字符串";
  if (!Array.isArray(event.images) || event.images.length > 9 || !event.images.every(isFileID)) return "图片必须为最多9个云文件ID";
  for (const key of ["audioFileId", "videoFileId", "videoThumbFileId", "liveMotionFileId"]) {
    if (event[key] !== undefined && event[key] !== "" && !isFileID(event[key])) return "媒体文件ID无效";
  }
  if (event.liveMotionFileId && !event.images.length) return "实况缺少封面";
  if (event.videoThumbFileId && !event.videoFileId) return "视频封面缺少视频";
  if (!event.text.trim() && !event.images.length && !event.audioFileId && !event.videoFileId && !event.liveMotionFileId) return "动态不能为空";
  return "";
}

async function handle(event) {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  if (action === "createPost") {
    if (!(await isMember(OPENID))) return { ok: false, msg: "仅圈子成员可发布" };
    const invalid = validatePost(event);
    if (invalid) return { ok: false, msg: invalid };
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
    return { ok: true, data, mediaUrls: await resolveMedia(posts) };
  }

  if (action === "deletePost") {
    const postId = event.postId;
    const docRes = await db.collection("posts").doc(postId).get();
    const post = docRes.data;
    if (!post) {
      return { ok: false, msg: "not found" };
    }
    const isAuthor = post.authorId === OPENID;
    const isAdmin = !!process.env.OWNER_OPENID && OPENID === process.env.OWNER_OPENID;
    if (!isAuthor && !isAdmin) {
      return { ok: false, msg: "no permission" };
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
      return { ok: false, msg: "no permission" };
    }
    const likeId = `${postId}_${OPENID}`;
    const likes = db.collection("likes");
    let existing;
    try {
      existing = (await likes.doc(likeId).get()).data;
    } catch (error) {
      // A missing document may reject; add below remains protected by its fixed _id.
      existing = null;
    }
    if (existing) {
      await likes.doc(likeId).remove();
      return { ok: true, liked: false };
    }
    try {
      await likes.add({ data: {
        _id: likeId, postId, userId: OPENID, createdAt: new Date().toISOString()
      } });
    } catch (error) {
      const raced = await likes.doc(likeId).get();
      if (!raced.data) throw error;
    }
    return { ok: true, liked: true };
  }

  if (action === "getPostDetail") {
    const postId = event.postId;
    const postRes = await db.collection("posts").doc(postId).get();
    const post = postRes.data;
    if (!(await canViewPost(post, OPENID))) {
      return { ok: false, msg: "no permission" };
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
      comments,
      mediaUrls: await resolveMedia([post])
    };
  }

  if (action === "addComment") {
    if (!(await isMember(OPENID))) return { ok: false, msg: "仅圈子成员可评论" };
    if (typeof event.content !== "string" || !event.content.trim() || event.content.trim().length > 500) {
      return { ok: false, msg: "评论须为1至500字" };
    }
    const postRes = await db.collection("posts").doc(event.postId).get();
    if (!(await canViewPost(postRes.data, OPENID))) {
      return { ok: false, msg: "no permission" };
    }
    await db.collection("comments").add({
      data: {
        postId: event.postId,
        userId: OPENID,
        content: event.content.trim(),
        createdAt: new Date().toISOString()
      }
    });
    return { ok: true };
  }

  return { ok: false, msg: "unknown action" };
}

exports.main = async (event) => {
  try {
    return await handle(event || {});
  } catch (error) {
    console.error("cloud function failed", error);
    return { ok: false, msg: "操作失败，请稍后重试" };
  }
};
