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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  if (action === "getSession") {
    const users = await db.collection("users").where({ openid: OPENID }).limit(1).get();
    const totalUsers = await db.collection("users").count();
    const firstUserRes = await db.collection("users").orderBy("createdAt", "asc").limit(1).get();
    const isAdmin =
      firstUserRes.data.length > 0 && firstUserRes.data[0].openid === OPENID;
    return {
      ok: true,
      openid: OPENID,
      user: users.data[0] || null,
      canBootstrap: totalUsers.total === 0,
      isAdmin
    };
  }

  if (action === "bootstrapOwner") {
    const totalUsers = await db.collection("users").count();
    if (totalUsers.total > 0) {
      return { ok: false, message: "圈子已创建，请使用邀请码进入" };
    }
    const user = await ensureUser(OPENID);
    return { ok: true, openid: OPENID, user };
  }

  if (action === "verifyInvite") {
    const code = (event.code || "").trim().toUpperCase();
    if (!code) {
      return { ok: false, message: "邀请码不能为空" };
    }
    const inviteRes = await db.collection("inviteCodes").where({
      code,
      isUsed: false
    }).limit(1).get();
    if (!inviteRes.data.length) {
      return { ok: false, message: "邀请码无效或已使用" };
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

  return { ok: false, message: "unknown action" };
};
