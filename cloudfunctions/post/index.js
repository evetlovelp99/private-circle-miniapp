const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function getAll(collection, condition, orderField = "_id", direction = "asc") {
  const rows = [];
  let offset = 0;
  while (true) {
    let query = db.collection(collection).where(condition).orderBy(orderField, direction);
    if (orderField !== "_id") query = query.orderBy("_id", "asc");
    const result = await query.skip(offset).limit(100).get();
    rows.push(...result.data);
    if (result.data.length < 100) return rows;
    offset += result.data.length;
  }
}

async function getRelationsMap(viewerOpenid) {
  const relations = await getAll("relations", { viewerUserId: viewerOpenid });
  return relations.reduce((acc, r) => {
    acc[r.ownerUserId] = r.canViewUntil || null;
    return acc;
  }, {});
}

async function getUsersMap(openids) {
  if (!openids.length) return {};
  const users = [];
  const unique = [...new Set(openids)];
  for (let i = 0; i < unique.length; i += 20) {
    users.push(...await getAll("users", { openid: _.in(unique.slice(i, i + 20)) }));
  }
  return users.reduce((acc, u) => {
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
    if (event.before !== undefined && (typeof event.before !== "string" || !Number.isFinite(Date.parse(event.before)))) {
      return { ok: false, msg: "分页时间无效" };
    }
    if (event.beforeId !== undefined && typeof event.beforeId !== "string") return { ok: false, msg: "分页ID无效" };
    const visibility = [{ authorId: OPENID }];
    for (const [authorId, cutoff] of Object.entries(relationsMap)) {
      if (authorId === OPENID) continue;
      visibility.push(cutoff ? { authorId, createdAt: _.lte(cutoff) } : { authorId });
    }
    let condition = _.or(visibility);
    if (event.before) {
      const cursor = event.beforeId ? _.or([
        { createdAt: _.lt(event.before) },
        { createdAt: event.before, _id: _.lt(event.beforeId) }
      ]) : { createdAt: _.lt(event.before) };
      condition = _.and([condition, cursor]);
    }
    const postRes = await db.collection("posts").where(condition)
      .orderBy("createdAt", "desc").orderBy("_id", "desc").limit(21).get();
    const hasMore = postRes.data.length > 20;
    const posts = postRes.data.slice(0, 20);
    const postIds = posts.map((p) => p._id);
    const usersMap = await getUsersMap(posts.map((post) => post.authorId));

    let likes = [];
    let comments = [];
    if (postIds.length) {
      likes = await getAll("likes", { postId: _.in(postIds) });
      comments = await getAll("comments", { postId: _.in(postIds) });
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
    const last = posts[posts.length - 1];
    return { ok: true, data, mediaUrls: await resolveMedia(posts), hasMore,
      nextCursor: last ? { before: last.createdAt, beforeId: last._id } : null };
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

    const fileIDs = collectFileIDs(post);
    for (let i = 0; i < fileIDs.length; i += 50) {
      const batch = fileIDs.slice(i, i + 50);
      const deleted = await cloud.deleteFile({ fileList: batch });
      if (!deleted.fileList || batch.some((id) =>
        !deleted.fileList.some((file) => file.fileID === id && file.status === 0))) {
        return { ok: false, msg: "部分媒体删除失败，请重试" };
      }
    }
    for (const collection of ["likes", "comments"]) {
      while (true) {
        const batch = await db.collection(collection).where({ postId }).limit(100).get();
        if (!batch.data.length) break;
        for (const record of batch.data) await db.collection(collection).doc(record._id).remove();
      }
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
    const commentsRes = { data: await getAll("comments", { postId }, "createdAt") };
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
