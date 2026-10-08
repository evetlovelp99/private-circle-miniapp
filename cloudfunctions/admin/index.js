const crypto = require("crypto");
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  // 32 symbols divides 256 exactly: no modulo bias.
  return [...crypto.randomBytes(12)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

async function ensureAdmin(openid) {
  return !!process.env.OWNER_OPENID && openid === process.env.OWNER_OPENID;
}

async function handle(event) {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  const isAdmin = await ensureAdmin(OPENID);
  if (!isAdmin) {
    return { ok: false, msg: "only admin allowed" };
  }

  if (action === "createInviteCode") {
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomCode();
      const existing = await db.collection("inviteCodes").where({ code }).limit(1).get();
      if (existing.data.length) continue;
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      try {
        await db.collection("inviteCodes").add({ data: {
          _id: code, code, createdBy: OPENID, usedBy: "", used: false,
          createdAt: new Date().toISOString(), expiresAt
        } });
        return { ok: true, code, expiresAt };
      } catch (error) {
        const collision = await db.collection("inviteCodes").where({ code }).limit(1).get();
        if (!collision.data.length) throw error;
      }
    }
    return { ok: false, msg: "邀请码生成失败，请重试" };
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
      return { ok: false, msg: "relation not found" };
    }
    await db.collection("relations").doc(relRes.data[0]._id).update({
      data: {
        canViewUntil: new Date().toISOString()
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
