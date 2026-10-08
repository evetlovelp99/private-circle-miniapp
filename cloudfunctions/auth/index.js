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

  if (action === "getStats") {
    const { dayStart, dayEnd } = event;
    const hour = 60 * 60 * 1000;
    const now = Date.now();
    if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd) ||
        dayEnd - dayStart < 23 * hour || dayEnd - dayStart > 25 * hour ||
        now < dayStart - hour || now > dayEnd + hour) {
      return { ok: false, msg: "统计时间范围无效" };
    }

    // Mirrors post/index.js:isMember, including owner access without a profile.
    const owner = process.env.OWNER_OPENID;
    if (!owner) return { ok: false, msg: "仅圈子成员可查看统计" };
    if (OPENID !== owner) {
      const profile = await db.collection("users").where({ openid: OPENID }).limit(1).get();
      const relation = await db.collection("relations").where({
        ownerUserId: owner, viewerUserId: OPENID
      }).limit(1).get();
      if (!profile.data.length || !relation.data.length) {
        return { ok: false, msg: "仅圈子成员可查看统计" };
      }
    }

    async function readAll(collection, condition) {
      const records = [];
      while (true) {
        const result = await db.collection(collection).where(condition)
          .orderBy("_id", "asc").skip(records.length).limit(100).get();
        records.push(...result.data);
        if (result.data.length < 100) return records;
      }
    }
    const memberRelations = await readAll("relations", { ownerUserId: owner });
    const candidates = [...new Set(memberRelations.map(r => r.viewerUserId))];
    const members = new Set([owner]);
    for (let i = 0; i < candidates.length; i += 20) {
      const profiles = await readAll("users", { openid: _.in(candidates.slice(i, i + 20)) });
      profiles.forEach(profile => members.add(profile.openid));
    }

    // Match listPosts: own posts plus each related author's optional cutoff.
    const viewerRelations = await readAll("relations", { viewerUserId: OPENID });
    const cutoffs = viewerRelations.reduce((map, relation) => {
      map[relation.ownerUserId] = relation.canViewUntil || null;
      return map;
    }, {});
    const visibility = [{ authorId: OPENID }];
    for (const [authorId, cutoff] of Object.entries(cutoffs)) {
      if (authorId !== OPENID) visibility.push(cutoff
        ? { authorId, createdAt: _.lte(cutoff) } : { authorId });
    }
    const start = new Date(dayStart).toISOString();
    const end = new Date(dayEnd).toISOString();
    const posts = await readAll("posts", _.and([
      _.or(visibility), { createdAt: _.gte(start) }, { createdAt: _.lt(end) }
    ]));
    return { ok: true, memberCount: members.size, todayPostCount: posts.length };
  }

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

  if (action === "updateNickname") {
    const users = db.collection("users");
    const profileRes = await users.where({ openid: OPENID }).limit(1).get();
    // Mirrors cloudfunctions/post/index.js:isMember; keep these membership rules in sync.
    const ownerOpenid = process.env.OWNER_OPENID;
    let member = !!ownerOpenid && OPENID === ownerOpenid;
    if (!member && ownerOpenid && profileRes.data.length) {
      const relations = await db.collection("relations").where({
        ownerUserId: ownerOpenid, viewerUserId: OPENID
      }).limit(1).get();
      member = !!relations.data.length;
    }
    if (!member) return { ok: false, msg: "仅圈子成员可改名" };
    if (!profileRes.data.length) return { ok: false, msg: "用户资料不存在" };
    if (typeof event.nickname !== "string") return { ok: false, msg: "昵称须为1至12个字符" };
    const nickname = event.nickname.trim();
    const length = Array.from(nickname).length;
    if (length < 1 || length > 12) return { ok: false, msg: "昵称须为1至12个字符" };
    // Update only this caller, including legacy duplicate profile records.
    const updated = await users.where({ openid: OPENID }).update({ data: { nickname } });
    if (!updated.stats.updated) return { ok: false, msg: "改名失败，请重试" };
    return { ok: true, openid: OPENID, user: { ...profileRes.data[0], nickname } };
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
