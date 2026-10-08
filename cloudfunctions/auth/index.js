const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function ensureUser(openid) {
  const users = db.collection("users");
  const found = await users.where({ openid }).limit(1).get();
  if (found.data.length) return found.data[0];
  const user = {
    openid,
    nickname: `用户${openid.slice(-4)}`,
    avatar: "",
    createdAt: new Date().toISOString()
  };
  const added = await users.add({ data: user });
  return { ...user, _id: added._id };
}

async function handle(event) {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  if (action === "getSession") {
    const users = await db.collection("users").where({ openid: OPENID }).limit(1).get();
    const isAdmin = !!process.env.OWNER_OPENID && OPENID === process.env.OWNER_OPENID;
    return {
      ok: true,
      openid: OPENID,
      user: users.data[0] || null,
      canBootstrap: isAdmin && !users.data.length,
      isAdmin
    };
  }

  if (action === "bootstrapOwner") {
    if (!process.env.OWNER_OPENID || OPENID !== process.env.OWNER_OPENID) {
      return { ok: false, msg: "仅指定创建者可创建圈子" };
    }
    const user = await ensureUser(OPENID);
    return { ok: true, openid: OPENID, user };
  }

  if (action === "verifyInvite") {
    if (typeof event.code !== "string") return { ok: false, msg: "邀请码必须为字符串" };
    const code = event.code.trim().toUpperCase();
    if (!code) {
      return { ok: false, msg: "邀请码不能为空" };
    }
    const inviteRes = await db.collection("inviteCodes").where({
      code,
      isUsed: false
    }).limit(1).get();
    if (!inviteRes.data.length) {
      return { ok: false, msg: "邀请码无效或已使用" };
    }

    const invite = inviteRes.data[0];
    const user = await ensureUser(OPENID);
    await db.collection("inviteCodes").doc(invite._id).update({
      data: {
        isUsed: true,
        usedBy: OPENID,
        usedAt: new Date().toISOString()
      }
    });

    const relRes = await db.collection("relations").where({
      ownerUserId: invite.createdBy,
      viewerUserId: OPENID
    }).limit(1).get();
    if (!relRes.data.length) {
      await db.collection("relations").add({
        data: {
          ownerUserId: invite.createdBy,
          viewerUserId: OPENID,
          canViewUntil: null,
          createdAt: new Date().toISOString()
        }
      });
    }
    return { ok: true, openid: OPENID, user };
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
