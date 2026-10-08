const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function ensureUser(openid) {
  const users = db.collection("users");
  const found = await users.where({ _id: openid }).limit(1).get();
  if (found.data.length) return found.data[0];
  const legacy = await users.where({ openid }).limit(1).get();
  const user = {
    openid,
    nickname: `用户${openid.slice(-4)}`,
    avatar: "",
    createdAt: new Date().toISOString()
  };
  const canonical = { ...(legacy.data[0] || user), _id: openid, openid };
  try {
    await users.add({ data: canonical });
    return canonical;
  } catch (error) {
    const raced = await users.where({ _id: openid }).limit(1).get();
    if (raced.data.length) return raced.data[0];
    throw error;
  }
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
      used: false
    }).limit(1).get();
    if (!inviteRes.data.length) {
      return { ok: false, msg: "邀请码无效或已使用" };
    }

    const invite = inviteRes.data[0];
    const now = new Date().toISOString();
    if (!process.env.OWNER_OPENID || invite.createdBy !== process.env.OWNER_OPENID ||
        typeof invite.expiresAt !== "string" || !Number.isFinite(Date.parse(invite.expiresAt)) || invite.expiresAt <= now) {
      return { ok: false, msg: "邀请码已过期或无效" };
    }
    const consumed = await db.collection("inviteCodes").where({
      code, used: false, expiresAt: _.gt(now), createdBy: process.env.OWNER_OPENID
    }).update({ data: { used: true, usedBy: OPENID, usedAt: now } });
    if (consumed.stats.updated !== 1) return { ok: false, msg: "邀请码已使用或过期" };
    const user = await ensureUser(OPENID);

    const relRes = await db.collection("relations").where({
      ownerUserId: invite.createdBy,
      viewerUserId: OPENID
    }).limit(1).get();
    if (!relRes.data.length) {
      try {
        await db.collection("relations").add({
        data: {
          _id: `${invite.createdBy}_${OPENID}`,
          ownerUserId: invite.createdBy,
          viewerUserId: OPENID,
          canViewUntil: null,
          createdAt: new Date().toISOString()
        }
        });
      } catch (error) {
        const raced = await db.collection("relations").where({
          ownerUserId: invite.createdBy, viewerUserId: OPENID
        }).limit(1).get();
        if (!raced.data.length) throw error;
      }
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
