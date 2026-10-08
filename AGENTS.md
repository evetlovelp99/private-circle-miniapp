# AGENTS.md — private-circle-miniapp

## Language
- Always reply to the user in **Chinese** (plans, explanations, change lists, checklists).
- Keep code, file paths, identifiers, and commit messages as-is (English is fine for code and commits).

## Project
- WeChat Mini Program + WeChat Cloud Development (云开发).
- Purpose: a private, invite-only circle. Members join with an invite code and can see the owner's posts.
- Previewed in WeChat DevTools. Real-device checks are done through 预览 (scan on phone).

## Structure (known)
- Pages: `pages/feed`, `pages/create`, `pages/me`, `pages/invite`, `pages/post`, `pages/admin`, `pages/members`
- Components: `components/blob-avatar` (hash-based color + two white eyes), `custom-tab-bar` (首页 / center orange + / 我的)
- Cloud functions: `cloudfunctions/auth`, `cloudfunctions/post`, `cloudfunctions/admin`
- Tests: `tests/security.cjs` (run with `node tests/security.cjs`)

## Data facts (do not break these)
- Member profiles live in the `users` collection. The nickname field is `nickname`.
- Default nickname is generated in `cloudfunctions/auth/index.js` → `ensureUser(openid)` as `用户${openid.slice(-4)}`.
- Posts store `authorId` (openid); comments store `userId` (openid). Nicknames are NOT denormalized.
  `listPosts` / `getPostDetail` resolve names at read time via `getUsersMap`.
- `blob-avatar` hashes the `identity` prop. Pages pass openid first, nickname only as fallback. Keep it that way.
- The only user cache is `app.globalData.user`. There is no wx storage cache for the user.
- The membership check in `cloudfunctions/auth` mirrors `cloudfunctions/post/index.js` → `isMember`. If you change one, change the other.
- Cloud functions must take the caller's openid from `cloud.getWXContext().OPENID`, never from frontend input.

## Design system (already in app.wxss — reuse its variables)
- Style: hand-drawn illustration feel. Flat, thick black outlines. **No shadows, no gradients.**
- Colors:
  - Page background `#FAECE7`, card `#FFFDF7`, outline/text `#2C2C2A`, secondary text `#5F5E5A`
  - Primary mist blue `#378ADD` / dark `#185FA5` / light `#B5D4F4`
  - Orange `#D85A30` (publish, + button), yellow `#FAC775`, pink `#F09595` (liked)
  - Green `#97C459` is accent only. **Never use green as a primary color.**
- Radius: cards 36rpx, buttons/tags/pills 999rpx, images 24rpx.
- The custom tabBar renders on a layer above the page; page z-index cannot cover it.
  Bottom sheets/modals must hide it via `this.getTabBar().setData({ hidden: true })` and restore it on every close path and `onHide`.

## Decided — do not build
- Per-post visibility selector. All members see all posts.

## Workflow rules
1. For any task: **read the relevant code first and list a plan. Do not modify files until the user confirms.**
2. Do **not** change cloud functions, database fields, or interfaces unless the task explicitly asks.
   If a data-structure change seems needed, stop and ask first.
   When adding a cloud action: add a new action only, never modify existing actions, keep the existing return format.
3. UI changes: the user approves a design preview before code. Follow the design system above.
4. After changes, always provide:
   - A per-file change list: file path + exact location (inserted after which block / replaced which block).
   - A WeChat DevTools checklist. Include a real-device (预览) check when the feature behaves differently on device
     (e.g. `type="nickname"`, `open-type` buttons, safe areas).
5. If a cloud function changed, remind the user to right-click it → 「上传并部署：云端安装依赖」.
6. Run `node tests/security.cjs` and add tests when behavior is testable.
7. **Do not git commit.** The user commits after checking.
