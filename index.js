"use strict";

const { Dialog, Plugin, fetchSyncPost, getFrontend } = require("siyuan");

const BOOK_NAME = "收藏";
const DEFAULT_FOLDERS = ["点子与摘录", "影视", "素材", "质量体系", "网页与链接", "其他收藏"];
const ARCHIVE_ATTR = "custom-inbox-review-source";
const ID_PATTERN = /^\d{14}-[a-z0-9]{7}$/;
const ROOT = { id: null, title: BOOK_NAME, names: [], children: [] };

const api = {
    notebooks: "/api/notebook/lsNotebooks",
    createNotebook: "/api/notebook/createNotebook",
    list: "/api/inbox/getShorthands",
    detail: "/api/inbox/getShorthand",
    sql: "/api/query/sql",
    create: "/api/filetree/createDocByParent",
    listDocs: "/api/filetree/listDocsByPath",
    attrs: "/api/attr/setBlockAttrs",
    localize: "/api/format/netAssets2LocalAssets",
};

async function request(path, payload = {}) {
    const response = await fetchSyncPost(path, payload);
    if (!response || response.code !== 0) {
        const error = new Error(response?.msg || "思源暂时无法完成请求");
        error.details = response?.data;
        throw error;
    }
    return response.data;
}

function sqlID(id) {
    if (!ID_PATTERN.test(id)) throw new Error("思源文档编号无效");
    return "'" + id + "'";
}

function archiveID(sourceID) {
    const source = String(sourceID);
    const millis = /^\d{13}$/.test(source) ? Number(source) : Date.UTC(2022, 0, 1);
    const timestamp = new Date(millis).toISOString().slice(0, 19).replace(/\D/g, "");
    let hash = 14695981039346656037n;
    for (const character of "siyuan-inbox-review:" + source) {
        hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 1099511628211n);
    }
    return timestamp + "-" + hash.toString(36).slice(-7).padStart(7, "0");
}

async function existingIDs(ids) {
    if (!ids.length) return new Set();
    const rows = await request(api.sql, {
        stmt: "SELECT id FROM blocks WHERE type = 'd' AND id IN (" + ids.map(sqlID).join(",") + ")",
    });
    return new Set((rows || []).map(row => row.id));
}

const pause = duration => new Promise(resolve => window.setTimeout(resolve, duration));

async function createDocument(payload) {
    let lastError;
    for (const delay of [0, 150, 350, 750, 1500, 2500]) {
        if (delay) await pause(delay);
        try {
            return await request(api.create, payload);
        } catch (error) {
            if (error.details?.commitState === "committed" ||
                (error.details?.reason !== "indexUnavailable" && !/document metadata is not ready/i.test(error.message))) {
                throw error;
            }
            lastError = error;
        }
    }
    throw lastError;
}

async function firstPending(skipped) {
    let lastPage = 1;
    for (let page = 1; page <= lastPage; page++) {
        const response = await request(api.list, { page });
        if (response?.code !== 0 || !response.data) throw new Error(response?.msg || "云端收集箱暂时不可用");
        lastPage = response.data.pagination.paginationPageCount;
        const items = response.data.shorthands.filter(item => item?.oId && !skipped.has(String(item.oId)));
        const processed = await existingIDs(items.map(item => archiveID(item.oId)));
        const pending = items.find(item => !processed.has(archiveID(item.oId)));
        if (pending) return pending;
    }
    return null;
}

function collectionNotebook(books) {
    const matches = books.filter(book => book.name === BOOK_NAME);
    if (matches.length > 1) throw new Error("有多个同名「收藏」笔记本，请先在文档树中区分名称。");
    if (matches[0]?.closed) throw new Error("请先在思源文档树中打开「收藏」笔记本。");
    return matches[0] || null;
}

async function collectionTree(bookID) {
    const rows = [];
    let cursor = "";
    const box = sqlID(bookID);
    for (;;) {
        const after = cursor ? " AND b.id > " + sqlID(cursor) : "";
        const chunk = await request(api.sql, {
            stmt: "SELECT b.id, b.path, b.content AS title, EXISTS (SELECT 1 FROM blocks c " +
                "WHERE c.root_id = b.id AND c.id <> b.id AND trim(c.markdown) <> '') AS has_body " +
                "FROM blocks b WHERE b.box = " + box + " AND b.type = 'd'" + after +
                " AND NOT EXISTS (SELECT 1 FROM attributes a WHERE a.block_id = b.id AND a.name = '" +
                ARCHIVE_ATTR + "') ORDER BY b.id LIMIT 200",
        });
        if (!chunk?.length) break;
        rows.push(...chunk);
        cursor = chunk.at(-1).id;
    }
    const root = { ...ROOT, children: [] };
    const nodes = new Map(rows.map(row => [row.id, {
        id: row.id,
        title: row.title?.trim() || "未命名文档",
        hasBody: Boolean(row.has_body),
        children: [],
    }]));
    for (const row of rows) {
        const parentID = row.path?.split("/").filter(Boolean).at(-2);
        const parent = parentID ? nodes.get(parentID) : root;
        parent?.children.push(nodes.get(row.id));
    }
    const candidates = [root];
    function organize(node) {
        node.children = node.children.filter(child => !child.hasBody || child.children.length);
        node.children.sort((left, right) => left.title.localeCompare(right.title, "zh-CN", { numeric: true }));
        for (const child of node.children) {
            child.names = [...node.names, child.title];
            candidates.push(child);
            organize(child);
        }
    }
    organize(root);
    return { root, candidates };
}

function safeURL(value, allowAsset = false) {
    const raw = String(value || "").trim();
    try {
        if (allowAsset && /^\/?assets\/[^\\]*$/i.test(raw) && !/%(?:2e|2f|5c)/i.test(raw)) {
            const local = new URL("/" + raw.replace(/^\//, ""), window.location.origin);
            return local.pathname.startsWith("/assets/") ? local.pathname + local.search : "";
        }
        const url = new URL(raw);
        if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
    } catch {
        // A plain message or a missing URL has no source link.
    }
    return "";
}

function hostedMedia(url) {
    if (!url.startsWith("https://")) return false;
    const resource = new URL(url);
    return !resource.port && ["assets.b3logfile.com", "b3logfile.com", "mmbiz.qpic.cn"].includes(resource.hostname);
}

function canPreviewImage(url) {
    if (url.startsWith("/assets/") || hostedMedia(url)) return true;
    const { protocol, port, hostname } = new URL(url);
    return protocol === "https:" && !port && /^sns-(?:webpic|img)(?:-[a-z0-9]+)*\.xhscdn\.com$/.test(hostname);
}

function reviewImages(entry) {
    const source = entry.source && new URL(entry.source).hostname;
    if (!source || !/(^|\.)(xiaohongshu\.com|xhslink\.cn)$/.test(source)) return entry.images;
    return entry.images.filter(url => {
        if (url.startsWith("/assets/")) return true;
        const { hostname } = new URL(url);
        return !/^sns-avatar(?:-[a-z0-9]+)*\.xhscdn\.com$/.test(hostname) &&
            hostname !== "fe-static.xhscdn.com" && hostname !== "picasso-static.xiaohongshu.com";
    });
}

function inertContent(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    template.content.querySelectorAll("script, style, iframe, object, embed, noscript").forEach(node => node.remove());
    return template.content;
}

function previewText(markdown, html) {
    if (!markdown) return inertContent(html).textContent.trim();
    const plain = markdown
        .replace(/!\[[^\]]*\]\([^\n]*?\)/g, "")
        .replace(/\[([^\]]+)\]\([^\n]*?\)/g, "$1")
        .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?)/gm, "")
        .replace(/\*\*|__|~~/g, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|li|blockquote|h[1-6])>/gi, "\n\n");
    return (/<[a-z!/][^>]*>/i.test(plain) ? inertContent(plain).textContent : plain).trim();
}

function mediaLinks(markdown, html) {
    const images = new Set();
    const attachments = new Set();
    for (const match of markdown.matchAll(/!\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)/g)) {
        const url = safeURL(match[1].replace(/^<|>$/g, ""), true);
        if (url) images.add(url);
    }
    const fragment = inertContent(html + "\n" + markdown);
    for (const image of fragment.querySelectorAll("img")) {
        const url = safeURL(image.getAttribute("src") || image.getAttribute("data-src"), true);
        if (url) images.add(url);
    }
    for (const link of fragment.querySelectorAll("a[href],audio[src],video[src],source[src]")) {
        const url = safeURL(link.getAttribute("href") || link.getAttribute("src"), true);
        if (url && (link.tagName !== "A" || /\.(pdf|zip|rar|docx?|xlsx?|pptx?|mp[34]|wav|amr|aac)(?:[?#]|$)/i.test(url))) {
            attachments.add(url);
        }
    }
    for (const match of markdown.matchAll(/(?<!!)\[[^\]]+\]\(\s*(<[^>]+>|[^\s)]+)/g)) {
        const url = safeURL(match[1].replace(/^<|>$/g, ""), true);
        if (/\.(pdf|zip|rar|docx?|xlsx?|pptx?|mp[34]|wav|amr|aac)(?:[?#]|$)/i.test(url)) attachments.add(url);
    }
    return { images: [...images], attachments: [...attachments] };
}

function entryView(item) {
    const markdown = String(item.shorthandMd || "").trim();
    const html = String(item.shorthandContent || "");
    const source = safeURL(item.shorthandURL);
    const text = previewText(markdown, html);
    const media = mediaLinks(markdown, html);
    const title = (String(item.shorthandTitle || "").trim() || text.split(/\r?\n/, 1)[0] || "微信收藏")
        .replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
    return { id: String(item.oId), title, text, markdown, source, date: item.hCreated || "", ...media };
}

const TOPIC_RULES = [
    [/8d|八步纠正/i, /\b8d\b|八步纠正/i, "内容涉及 8D 整改"],
    [/体系审核|质量审核/, /体系审核|质量审核|内审|审核计划/, "内容涉及体系审核"],
    [/检验管理|质量检验/, /抽样检验|来料检验|出货检验|检验规范/, "内容涉及质量检验"],
    [/质量体系|质量管理/, /质量体系|质量管理|根因分析|纠正措施|\b8d\b|质量审核|iso\s*9001/i, "内容涉及质量体系"],
];

function recommend(entry, candidates) {
    const title = entry.title.normalize("NFKC").toLowerCase();
    const content = entry.text.slice(0, 6000).normalize("NFKC").toLowerCase();
    const related = candidates.flatMap(node => {
        if (!node.id) return [];
        const name = node.title.normalize("NFKC").toLowerCase();
        const rule = TOPIC_RULES.find(([folder, text]) => folder.test(name) && text.test(title + "\n" + content));
        const matchesTitle = name.length > 1 && title.includes(name);
        const matchesBody = name.length > 1 && content.includes(name);
        if (!rule && !matchesTitle && !matchesBody) return [];
        const score = (rule ? 10 : 0) + (matchesTitle ? 8 : matchesBody ? 3 : 0) +
            (rule && rule === TOPIC_RULES[0] ? 10 : 0) + Math.min(node.names.length, 3);
        return [{ node, score, reason: rule?.[2] || (matchesTitle ? "标题提到「" : "正文提到「") + node.title + "」" }];
    }).sort((left, right) => right.score - left.score);
    if (related.length) return related[0];

    const film = /^https?:\/\/(?:movie\.douban\.com\/subject\/|(?:www\.)?imdb\.com\/title\/|(?:www\.)?themoviedb\.org\/(?:movie|tv)\/)/i.test(entry.source);
    let preferred = [/其他|杂项/, "没有明确匹配的主题"];
    if (film) preferred = [/影视|电影|剧集/, "来源是电影或剧集条目"];
    else if (entry.source) preferred = [/网页|链接|文章/, "这条收藏带有原网页链接"];
    else if (entry.images.length || entry.attachments.length) preferred = [/素材|图片|附件/, "这条收藏包含图片或附件"];
    else if (entry.text) preferred = [/点子|摘录|灵感|随手记/, "这是一条文字收藏"];
    const match = candidates.find(node => node.id && preferred[0].test(node.title));
    return match
        ? { node: match, reason: preferred[1] }
        : { node: candidates.find(node => node.id && /其他|杂项/.test(node.title)) || candidates[0],
            reason: "没有找到匹配的分类，先建议这个位置" };
}

function breadcrumb(node) {
    return [BOOK_NAME, ...node.names].join(" › ");
}

function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
}

function button(label, click, primary = false) {
    const node = element("button", label, primary ? "b3-button b3-button--text" : "b3-button b3-button--cancel");
    node.type = "button";
    node.addEventListener("click", click);
    return node;
}

function link(label, url) {
    const node = element("a", label);
    node.href = url;
    node.target = "_blank";
    node.rel = "noopener noreferrer";
    return node;
}

function addParagraphs(target, content) {
    for (const paragraph of content.split(/\n\s*\n/).filter(Boolean)) {
        target.append(element("p", paragraph));
    }
}

function entryPreview(entry, openImages) {
    const images = reviewImages(entry);
    const section = element("section", "", "siyuan-inbox-review__preview");
    const meta = element("div", "", "siyuan-inbox-review__muted");
    if (entry.date) meta.append(element("span", entry.date));
    if (entry.source) meta.append(link("打开原网页", entry.source));
    const scroll = element("div", "", "siyuan-inbox-review__preview-scroll");
    scroll.id = "siyuan-inbox-review-preview-" + archiveID(entry.id);
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "收藏正文和附件");
    section.append(element("h3", entry.title), meta, scroll);
    const tools = element("div", "", "siyuan-inbox-review__preview-tools");

    if (entry.text) {
        const text = element("div", "", "siyuan-inbox-review__copy");
        const paragraphs = entry.text.split(/\n\s*\n/).filter(Boolean);
        const excerpt = paragraphs.slice(0, 3).join("\n\n").slice(0, 740);
        addParagraphs(text, excerpt + (excerpt.length < entry.text.length && excerpt.length === 740 ? "…" : ""));
        scroll.append(text);
        if (excerpt.length < entry.text.length) {
            const full = element("div", "", "siyuan-inbox-review__copy");
            full.hidden = true;
            scroll.append(full);
            const toggle = button("展开完整正文", () => {
                const expanding = full.hidden;
                if (expanding && !full.childNodes.length) addParagraphs(full, entry.text);
                full.hidden = !expanding;
                text.hidden = expanding;
                scroll.scrollTop = 0;
                toggle.textContent = expanding ? "收起正文" : "展开完整正文";
                toggle.setAttribute("aria-expanded", String(expanding));
            });
            toggle.setAttribute("aria-controls", scroll.id);
            toggle.setAttribute("aria-expanded", "false");
            tools.append(toggle);
        }
    } else if (!images.length && !entry.attachments.length) {
        scroll.append(element("p", entry.source ? "这条收藏只有原网页链接。" : "思源收集箱没有提供可预览的正文。"));
    }
    if (images.length) {
        const gallery = element("div", "", "siyuan-inbox-review__gallery");
        images.slice(0, 6).forEach((url, index) => {
            const thumbnail = button("图片 " + (index + 1), () => openImages(images, index));
            thumbnail.classList.add("siyuan-inbox-review__thumbnail");
            thumbnail.setAttribute("aria-label", "查看第 " + (index + 1) + " 张图片");
            if (canPreviewImage(url)) {
                const photo = element("img");
                photo.alt = "";
                photo.referrerPolicy = "no-referrer";
                photo.loading = "lazy";
                photo.addEventListener("error", () => {
                    thumbnail.textContent = "图片 " + (index + 1);
                }, { once: true });
                photo.src = url;
                thumbnail.replaceChildren(photo);
            }
            gallery.append(thumbnail);
        });
        scroll.append(gallery);
        tools.append(button("查看图片（" + images.length + " 张）", () => openImages(images, 0)));
    }
    for (const url of entry.attachments) {
        const name = url.split(/[?#]/, 1)[0].split("/").at(-1);
        let label = name || "打开附件";
        try { label = decodeURIComponent(label); } catch { /* Keep the encoded filename. */ }
        scroll.append(link(label, url));
    }
    if (tools.childNodes.length) section.append(tools);
    return section;
}

function treePicker(tree, selection, onSelect) {
    const group = element("div", "", "siyuan-inbox-review__tree");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", "收藏笔记本的归档位置");

    function option(node, label) {
        const row = element("label", "", "siyuan-inbox-review__option");
        const input = element("input");
        input.type = "radio";
        input.name = "siyuan-inbox-review-target";
        input.checked = node.id === selection.id;
        input.setAttribute("aria-label", breadcrumb(node));
        input.addEventListener("change", () => onSelect(node));
        row.append(input, element("span", label));
        return row;
    }
    function branch(node) {
        if (!node.children.length) return option(node, node.title);
        const details = element("details");
        details.open = node.names.every((name, index) => selection.names[index] === name);
        details.append(element("summary", node.title));
        const children = element("div", "", "siyuan-inbox-review__children");
        children.append(option(node, "存到此级"), ...node.children.map(branch));
        details.append(children);
        return details;
    }
    group.append(option(tree.root, "收藏本级"), ...tree.root.children.map(branch));
    return group;
}

function notebookReferences(books) {
    const all = element("details", "", "siyuan-inbox-review__details");
    all.append(element("summary", "现有笔记本路径（参考）"));
    const list = element("div", "", "siyuan-inbox-review__children");
    function pathBranch(book, title, path, closed = false) {
        const details = element("details");
        details.append(element("summary", title));
        const content = element("div", "", "siyuan-inbox-review__children");
        details.append(content);
        let loaded = false;
        details.addEventListener("toggle", async () => {
            if (!details.open || loaded) return;
            loaded = true;
            content.textContent = closed ? "这个笔记本当前已关闭。" : "正在读取目录…";
            if (closed) return;
            try {
                const data = await request(api.listDocs, { notebook: book.id, path, maxListCount: 1000 });
                const files = (data.files || []).filter(Boolean);
                content.replaceChildren(...files.map(file => file.subFileCount
                    ? pathBranch(book, file.name, file.path)
                    : element("div", file.name)));
                if (!files.length) content.textContent = "这里还没有子文档。";
            } catch {
                content.textContent = "暂时无法读取目录，合上后可再次展开。";
                loaded = false;
            }
        });
        return details;
    }
    list.append(...books.filter(book => book.name !== BOOK_NAME)
        .map(book => pathBranch(book, book.name, "/", book.closed)));
    all.append(list);
    return all;
}

function archiveMarkdown(entry) {
    const fallback = [entry.text,
        ...entry.images.map(url => "![](<" + url.replace(/^\/assets\//, "assets/") + ">)"),
        ...entry.attachments.map(url => "[附件](<" + url.replace(/^\/assets\//, "assets/") + ">)")];
    const body = entry.markdown || fallback.filter(Boolean).join("\n\n");
    const source = entry.source ? "原网页：[打开链接](<" + entry.source + ">)" : "";
    return [body, source].filter(Boolean).join("\n\n");
}

async function createArchive(entry, bookID, target) {
    const id = archiveID(entry.id);
    if ((await existingIDs([id])).has(id)) return { id, already: true };
    const markdown = archiveMarkdown(entry);
    if (!markdown) throw new Error("这条收藏暂时没有可写入的内容。");
    try {
        await createDocument({
            id, notebook: bookID, parentID: target.id,
            title: { format: "plain", text: entry.title }, markdown, listDocTree: true,
            ...(entry.source ? { clippingHref: entry.source } : {}),
        });
    } catch (error) {
        if (!(await existingIDs([id])).has(id)) throw error;
        return { id, already: true };
    }

    const notices = [];
    try {
        await request(api.attrs, { id, attrs: { [ARCHIVE_ATTR]: entry.id } });
    } catch {
        notices.push("归档已保存，来源标记暂未写入。");
    }
    const media = [...entry.images, ...entry.attachments].filter(url => /^https?:\/\//i.test(url));
    const remoteURLs = markdown.match(/https?:\/\/[^\s<>"')]+/gi) || [];
    if (media.length && remoteURLs.every(url => {
        const valid = safeURL(url);
        return valid && (hostedMedia(valid) || valid === entry.source);
    }) && media.every(hostedMedia)) {
        try {
            await request(api.localize, { id });
        } catch {
            notices.push("部分网络资源暂时未转为本地文件，可从原收藏查看。");
        }
    }
    return { id, notices };
}

module.exports = class InboxReview extends Plugin {
    onLayoutReady() {
        if (!["desktop", "browser-desktop"].includes(getFrontend()) ||
            document.body.classList.contains("body--settings") || window.siyuan?.config?.readonly ||
            window.siyuan?.isPublish) return;
        this.skipped = new Set();
        this.addCommand({ langKey: "收集箱整理", hotkey: "", callback: () => this.openReview() });
        this.firstTimer = window.setTimeout(() => this.checkInbox(), 1200);
        this.pollTimer = window.setInterval(() => this.checkInbox(), 120000);
    }

    onunload() {
        this.disposed = true;
        this.stopReminder();
        this.imageDialog?.destroy();
        this.dialog?.destroy();
    }

    stopReminder() {
        this.reminderShown = true;
        window.clearTimeout(this.firstTimer);
        window.clearInterval(this.pollTimer);
        this.toast?.remove();
        this.toast = null;
    }

    async checkInbox() {
        if (this.disposed || this.reminderShown || this.checking) return;
        this.checking = true;
        try {
            const item = await firstPending(this.skipped);
            if (item && !this.disposed && !this.reminderShown) this.showReminder();
        } catch {
            // Cloud login and transient network errors can recover on the next check.
        } finally {
            this.checking = false;
        }
    }

    showReminder() {
        this.stopReminder();
        const toast = element("div", "", "siyuan-inbox-review__toast");
        const open = button("有收藏待整理", () => this.openReview());
        const dismiss = button("×", () => this.stopReminder());
        dismiss.setAttribute("aria-label", "关闭收藏提醒，本次跳过");
        toast.append(open, dismiss);
        document.body.append(toast);
        this.toast = toast;
    }

    openReview() {
        if (this.disposed || this.dialog) return;
        this.stopReminder();
        const dialog = new Dialog({
            title: "收集箱整理",
            content: '<div class="siyuan-inbox-review__dialog" data-inbox-review></div>',
            width: "min(660px, 94vw)",
            destroyCallback: () => {
                this.imageDialog?.destroy();
                if (this.dialog === dialog) this.dialog = null;
            },
        });
        this.dialog = dialog;
        const close = button("×", () => dialog.destroy());
        close.classList.add("siyuan-inbox-review__close");
        close.setAttribute("aria-label", "结束本次整理");
        dialog.element.querySelector(".b3-dialog__container").append(close);
        this.loadNext(dialog);
    }

    previewEntry(entry) {
        return entryPreview(entry, (images, index) => this.openImages(images, index));
    }

    openImages(images, index) {
        if (!this.dialog || this.imageDialog) return;
        const dialog = new Dialog({
            title: "查看图片",
            content: '<div class="siyuan-inbox-review__viewer"></div>',
            width: "min(1060px, 94vw)",
            destroyCallback: () => {
                if (this.imageDialog === dialog) this.imageDialog = null;
            },
        });
        this.imageDialog = dialog;
        const viewer = dialog.element.querySelector(".siyuan-inbox-review__viewer");
        const frame = element("div", "", "siyuan-inbox-review__image-frame");
        const counter = element("span", "", "siyuan-inbox-review__muted");
        counter.setAttribute("role", "status");
        const previous = button("上一张", () => show(index - 1));
        const next = button("下一张", () => show(index + 1));
        const original = link("打开原图", images[index]);
        const close = button("关闭", () => dialog.destroy());
        const controls = element("div", "", "siyuan-inbox-review__viewer-controls");
        controls.append(previous, counter, next, original, close);
        viewer.append(frame, controls);

        function show(position) {
            if (position < 0 || position >= images.length) return;
            index = position;
            const url = images[index];
            previous.disabled = index === 0;
            next.disabled = index === images.length - 1;
            counter.textContent = (index + 1) + " / " + images.length;
            original.href = url;
            const notice = element("p", "", "siyuan-inbox-review__muted");
            if (!canPreviewImage(url)) {
                notice.textContent = "可点击「打开原图」查看这张图片。";
                frame.replaceChildren(notice);
                return;
            }
            const photo = element("img");
            photo.alt = "第 " + (index + 1) + " 张收藏图片";
            photo.referrerPolicy = "no-referrer";
            photo.addEventListener("error", () => {
                notice.textContent = "图片加载失败，可尝试打开原图。";
                photo.replaceWith(notice);
            }, { once: true });
            photo.src = url;
            frame.replaceChildren(photo);
        }

        viewer.addEventListener("keydown", event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.stopPropagation();
            show(index + (event.key === "ArrowRight" ? 1 : -1));
        });
        show(index);
        close.focus();
    }

    async loadNext(dialog) {
        const panel = dialog.element.querySelector("[data-inbox-review]");
        const note = element("p", "正在读取收集箱…", "siyuan-inbox-review__notice");
        panel.replaceChildren(note);
        try {
            const item = await firstPending(this.skipped);
            if (this.dialog !== dialog) return;
            if (!item) {
                note.textContent = "暂时没有待整理的收藏。";
                return;
            }
            const [detail, bookList] = await Promise.all([
                request(api.detail, { id: String(item.oId) }),
                request(api.notebooks),
            ]);
            if (this.dialog !== dialog) return;
            const entry = entryView({ ...item, ...detail, oId: item.oId });
            const books = (bookList.notebooks || []).filter(Boolean);
            const book = collectionNotebook(books);
            if (!book) {
                this.offerCollectionBook(dialog, panel, entry);
                return;
            }
            const tree = await collectionTree(book.id);
            if (this.dialog === dialog) this.showItem(dialog, panel, entry, books, book, tree);
        } catch (error) {
            if (this.dialog === dialog) {
                note.textContent = "暂时无法读取收藏。" + error.message;
                panel.append(button("重试", () => this.loadNext(dialog)));
            }
        }
    }

    offerCollectionBook(dialog, panel, entry) {
        const status = element("p", "首次整理可创建「收藏」和常用目录。", "siyuan-inbox-review__notice");
        const create = button("创建收藏笔记本", async () => {
            create.disabled = true;
            status.textContent = "正在创建收藏笔记本…";
            try {
                const { notebooks } = await request(api.notebooks);
                const existing = collectionNotebook(notebooks);
                if (!existing) {
                    const { notebook } = await request(api.createNotebook, { name: BOOK_NAME });
                    const created = [];
                    for (const name of DEFAULT_FOLDERS) {
                        const id = window.Lute.NewNodeID();
                        await createDocument({
                            notebook: notebook.id, parentID: null, id,
                            title: { format: "plain", text: name }, markdown: "", listDocTree: true,
                        });
                        created.push(id);
                    }
                    let indexed = false;
                    for (let check = 0; check < 24; check++) {
                        indexed = (await existingIDs(created)).size === created.length;
                        if (indexed) break;
                        await pause(250);
                    }
                    if (!indexed && this.dialog === dialog) {
                        status.textContent = "笔记本和分类已创建，思源正在刷新目录。";
                        panel.replaceChildren(this.previewEntry(entry), status, button("刷新目录", () => this.loadNext(dialog)));
                        return;
                    }
                }
                if (this.dialog === dialog) await this.loadNext(dialog);
            } catch (error) {
                if (this.dialog !== dialog) return;
                status.textContent = "创建未完成。" + error.message;
                create.disabled = false;
                panel.append(button("刷新目录", () => this.loadNext(dialog)));
            }
        }, true);
        panel.replaceChildren(this.previewEntry(entry), status, create);
    }

    showItem(dialog, panel, entry, books, book, tree) {
        const suggestion = recommend(entry, tree.candidates);
        let selected = suggestion.node;
        const recommendation = element("section", "", "siyuan-inbox-review__recommendation");
        recommendation.append(element("div", "推荐位置", "siyuan-inbox-review__muted"),
            element("strong", breadcrumb(selected)), element("div", suggestion.reason, "siyuan-inbox-review__muted"));
        const destination = element("span", "归档到 " + breadcrumb(selected), "siyuan-inbox-review__muted");
        destination.setAttribute("aria-live", "polite");
        const choose = element("details", "", "siyuan-inbox-review__details");
        choose.append(element("summary", "查看或改选收藏目录"),
            treePicker(tree, selected, node => {
                selected = node;
                destination.textContent = "归档到 " + breadcrumb(selected);
            }));
        const status = element("div", "", "siyuan-inbox-review__muted");
        status.setAttribute("role", "status");
        const skip = button("跳过这条", () => {
            this.skipped.add(entry.id);
            this.loadNext(dialog);
        });
        const confirm = button("确认归档", async () => {
            skip.disabled = confirm.disabled = true;
            status.textContent = "正在归档…";
            const target = selected;
            try {
                const saved = await createArchive(entry, book.id, target);
                this.skipped.add(entry.id);
                if (this.dialog !== dialog) return;
                const completed = element("p", saved.already ? "这条收藏已经归档。" : "已归档到 " + breadcrumb(target));
                const actions = element("div", "", "siyuan-inbox-review__actions");
                actions.append(button("结束", () => dialog.destroy()),
                    button("再来一条", () => this.loadNext(dialog), true));
                panel.replaceChildren(completed);
                for (const notice of saved.notices || []) panel.append(element("p", notice, "siyuan-inbox-review__muted"));
                panel.append(actions);
            } catch (error) {
                if (this.dialog !== dialog) return;
                status.textContent = "归档未完成。" + error.message;
                skip.disabled = confirm.disabled = false;
            }
        }, true);
        const footer = element("div", "", "siyuan-inbox-review__footer");
        const actions = element("div", "", "siyuan-inbox-review__actions");
        actions.append(skip, confirm);
        footer.append(destination, actions);
        panel.replaceChildren(this.previewEntry(entry), recommendation, choose, notebookReferences(books), status, footer);
    }
};

