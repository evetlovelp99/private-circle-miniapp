const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

async function ensureUser(openid) {
  const userRes = await db.collection("users").where({ openid }).limit(1).get();
  if (userRes.data.length) return userRes.data[0];
  const user = {
    openid,
    nickname: `用户${openid.slice(-4)}`,
    avatar: "",
    createdAt: new Date().toISOString()
  };
  const added = await db.collection("users").add({ data: user });
  return { ...user, _id: added._id };
}

async function ensureAdmin(openid) {
  const firstUserRes = await db.collection("users").orderBy("createdAt", "asc").limit(1).get();
  if (!firstUserRes.data.length) return true;
  return firstUserRes.data[0].openid === openid;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  const isAdmin = await ensureAdmin(OPENID);
  if (!isAdmin) {
    return { ok: false, message: "only admin allowed" };
  }

  if (action === "createInviteCode") {
    const code = randomCode();
    await db.collection("inviteCodes").add({
      data: {
        code,
        createdBy: OPENID,
        usedBy: "",
        isUsed: false,
        createdAt: new Date().toISOString()
      }
    });
    return { ok: true, code };
  }

  if (action === "listMembers") {
    const relRes = await db.collection("relations").where({
      ownerUserId: OPENID
    }).get();
    const viewers = relRes.data.map((r) => r.viewerUserId);
    if (!viewers.length) {
      return { ok: true, members: [] };
    }
    const userRes = await db.collection("users").where({
      openid: _.in(viewers)
    }).get();
    const byOpenid = userRes.data.reduce((acc, u) => {
      acc[u.openid] = u;
      return acc;
    }, {});
    const members = relRes.data.map((r) => {
      const u = byOpenid[r.viewerUserId];
      let status = "可看新动态";
      if (r.canViewUntil) status = `已静默切断（止于 ${String(r.canViewUntil).slice(0, 19)}）`;
      return {
        viewerOpenid: r.viewerUserId,
        nickname: u?.nickname || r.viewerUserId.slice(-6),
        relationId: r._id,
        canViewUntil: r.canViewUntil || null,
        statusLabel: status,
        cutoff: !!r.canViewUntil
      };
    });
    return { ok: true, members };
  }

  if (action === "silentCutoff") {
    const viewerOpenid = event.viewerOpenid;
    const relRes = await db.collection("relations").where({
      ownerUserId: OPENID,
      viewerUserId: viewerOpenid
    }).limit(1).get();
    if (!relRes.data.length) {
      return { ok: false, message: "relation not found" };
    }
    await db.collection("relations").doc(relRes.data[0]._id).update({
      data: {
        canViewUntil: new Date().toISOString()
      }
    });
    return { ok: true };
  }

  if (action === "seedFirstPost") {
    const user = await ensureUser(OPENID);
    const now = new Date().toISOString();
    const postAdded = await db.collection("posts").add({
      data: {
        authorId: OPENID,
        text: "第一条测试动态：如果你看到这条，说明动态流已经打通啦。",
        images: [],
        audio: "",
        video: "",
        videoThumb: "",
        liveMotion: "",
        createdAt: now
      }
    });

    await db.collection("comments").add({
      data: {
        postId: postAdded._id,
        userId: OPENID,
        content: "测试评论：评论功能正常。",
        createdAt: new Date().toISOString()
      }
    });

    await db.collection("likes").add({
      data: {
        postId: postAdded._id,
        userId: OPENID,
        createdAt: new Date().toISOString()
      }
    });

    return {
      ok: true,
      postId: postAdded._id,
      nickname: user.nickname
    };
  }

  return { ok: false, message: "unknown action" };
};
