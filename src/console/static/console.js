"use strict";
/*
 * 网页控制台（浏览器端）。所有内容用 DOM 接口生成（textContent），不拼接 HTML，
 * 交易所返回的队名、规则原文等外部文本不会被当作代码执行。
 * 口令只保存在本标签页（sessionStorage），关闭标签页即清除。
 */
(function () {
  // ------------------------------------------------------------------
  // 存储（隐私模式下可能不可用）
  // ------------------------------------------------------------------
  function sget(store, k, d) {
    try {
      var v = window[store].getItem(k);
      return v === null ? d : v;
    } catch (e) {
      return d;
    }
  }
  function sset(store, k, v) {
    try {
      if (v === null || v === "") window[store].removeItem(k);
      else window[store].setItem(k, v);
    } catch (e) {
      /* 忽略 */
    }
  }

  var S = {
    token: sget("sessionStorage", "console.token", ""),
    actor: sget("localStorage", "console.actor", ""),
    tab: sget("localStorage", "console.tab", "overview"),
    session: null,
    data: null,
    meta: null,
    open: new Set(),
    statsHours: sget("localStorage", "console.statsHours", "168"),
    busy: false,
  };
  try {
    JSON.parse(sget("sessionStorage", "console.open", "[]")).forEach(function (k) {
      S.open.add(k);
    });
  } catch (e) {
    /* 忽略 */
  }

  var TABS = [
    ["overview", "总览"],
    ["pairs", "配对"],
    ["review", "审核"],
    ["params", "全局参数"],
    ["stats", "补单统计"],
    ["audit", "操作记录"],
  ];
  var LIVE_TABS = { overview: true, pairs: true, review: true };

  var ACTIONS = {
    "global.halt": "全局停止新挂单",
    "global.resume": "解除全局停止",
    "global.params": "修改全局参数",
    "pair.pause": "暂停配对挂单",
    "pair.resume": "恢复配对挂单",
    "pair.params": "修改配对参数",
    "pair.reset": "清除配对参数覆盖",
    "pair.recheck": "重新核对",
    "pair.approve": "人工批准配对",
    reconcile: "对账",
    "pair.acceptPositions": "确认持仓基线",
    "pair.add": "新增配对",
    "pair.delete": "删除配对",
    "pair.restore": "恢复已删除配对",
  };
  var VERIFY = {
    APPROVED: ["核对通过", "ok"],
    APPROVED_MANUAL: ["人工批准", "ok"],
    PENDING_REVIEW: ["待审核", "warn"],
    REJECTED: ["未通过", "bad"],
    PAUSED_RECHECK: ["暂停待复核", "warn"],
  };
  var VENUE = { predict: "Predict", polymarket: "Polymarket" };

  // ------------------------------------------------------------------
  // DOM 工具
  // ------------------------------------------------------------------
  function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "innerHTML" || k === "outerHTML") throw new Error("不允许直接写 HTML");
        if (k === "class") el.className = v;
        else if (k.slice(0, 2) === "on" && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "value" || k === "checked" || k === "selected" || k === "disabled" || k === "open") el[k] = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) {
      kid.forEach(function (k) {
        append(el, k);
      });
      return;
    }
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  function $(id) {
    return document.getElementById(id);
  }
  function fmt(v) {
    if (v === null || v === undefined || v === "") return "-";
    if (typeof v === "boolean") return v ? "是" : "否";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  function kv(pairs) {
    var box = h("div", { class: "kv" });
    pairs.forEach(function (p) {
      if (!p) return;
      box.append(h("div", { class: "k" }, p[0]), h("div", { class: "v" }, p[1] instanceof Node ? p[1] : fmt(p[1])));
    });
    return box;
  }
  function table(rows, cols) {
    if (!rows || !rows.length) return h("div", { class: "empty" }, "无");
    var keys = cols || Object.keys(rows[0]);
    return h(
      "div",
      { class: "scroll" },
      h(
        "table",
        null,
        h("thead", null, h("tr", null, keys.map(function (k) {
          return h("th", null, Array.isArray(k) ? k[1] : k);
        }))),
        h("tbody", null, rows.map(function (r) {
          return h("tr", null, keys.map(function (k) {
            var key = Array.isArray(k) ? k[0] : k;
            var v = typeof key === "function" ? key(r) : r[key];
            return h("td", null, v instanceof Node ? v : fmt(v));
          }));
        })),
      ),
    );
  }
  function badge(text, cls) {
    return h("span", { class: "badge " + (cls || "") }, text);
  }
  function dot(cls, text) {
    return h("span", null, h("span", { class: "dot " + cls }), text);
  }
  function btn(text, onclick, cls, title, disabled) {
    return h("button", { type: "button", class: "btn " + (cls || ""), onclick: onclick, title: title || null, disabled: !!disabled }, text);
  }
  function card(title, body) {
    return h("div", { class: "card" }, title ? h("h3", null, title) : null, body);
  }
  function details(key, title, body) {
    var d = h("details", { open: S.open.has(key) }, h("summary", null, title), body);
    d.addEventListener("toggle", function () {
      if (d.open) S.open.add(key);
      else S.open.delete(key);
      sset("sessionStorage", "console.open", JSON.stringify(Array.from(S.open)));
    });
    return d;
  }
  var toastTimer = null;
  function toast(text, cls) {
    var t = $("toast");
    t.textContent = text;
    t.className = "toast " + (cls || "");
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      t.hidden = true;
    }, cls === "bad" ? 9000 : 4000);
  }

  // ------------------------------------------------------------------
  // 接口
  // ------------------------------------------------------------------
  function api(method, path, body) {
    var headers = { "x-console-actor": encodeURIComponent(S.actor || "console") };
    if (S.token) headers["x-console-token"] = S.token;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(path, { method: method, headers: headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "same-origin" }).then(function (res) {
      // 口令被拒（例如服务端换了口令）：立即清除，避免反复用错误口令请求触发锁定
      if (res.headers.get("x-console-token-rejected") === "1" && S.token && path !== "/api/session") {
        setToken("");
        S.session = null;
        toast("口令不正确或已更换，请重新登录", "bad");
      }
      return res.text().then(function (text) {
        var data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch (e) {
          data = { error: text };
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || "HTTP " + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }
  function canControl() {
    return !!(S.session && S.session.role === "control");
  }

  // ------------------------------------------------------------------
  // 登录与头部
  // ------------------------------------------------------------------
  function refreshSession() {
    return api("GET", "/api/session").then(function (s) {
      if (s.tokenRejected && S.token) {
        setToken("");
        toast("口令不正确或已更换，请重新登录", "bad");
        return api("GET", "/api/session").then(function (s2) {
          S.session = s2;
          renderHeader();
          return s2;
        });
      }
      S.session = s;
      renderHeader();
      return s;
    });
  }
  function setToken(t) {
    S.token = t;
    sset("sessionStorage", "console.token", t);
  }
  function renderHeader() {
    var s = S.session;
    var mode = $("mode");
    if (s) {
      mode.textContent = s.live ? "实盘" : "模拟";
      mode.className = "badge " + (s.live ? "live" : "");
    }
    var who = $("who");
    if (!s || !s.role) who.textContent = "未登录";
    else who.textContent = (s.role === "control" ? "可控制" : "只读") + (S.actor ? " · 操作人 " + S.actor : "");
    $("loginBtn").textContent = S.token ? "切换口令" : "登录";
  }
  function openLogin() {
    var tok = h("input", { type: "password", autocomplete: "current-password", placeholder: "CONSOLE_TOKEN 或 STATUS_TOKEN", value: "" });
    var actor = h("input", { type: "text", maxlength: "32", placeholder: "例如：张三", value: S.actor });
    var info = S.session && !S.session.controlEnabled ? h("div", { class: "msg warn" }, S.session.controlProblem || "控制台只读") : null;
    showDialog({
      title: "登录控制台",
      body: [
        info,
        h("label", { class: "field" }, h("span", null, "口令（只保存在本标签页，关闭即清除）"), tok),
        h("label", { class: "field" }, h("span", null, "操作人（写入操作记录，便于多人协作时区分）"), actor),
      ],
      okText: "登录",
      onOk: function () {
        S.actor = actor.value.trim();
        sset("localStorage", "console.actor", S.actor);
        setToken(tok.value.trim());
        return refreshSession().then(function (s) {
          if (!s.role) throw new Error("口令不正确");
          if (s.tokenRejected) throw new Error("口令不正确");
          toast(s.role === "control" ? "已登录（可控制）" : "已登录（只读）", "ok");
          poll(true);
        });
      },
      secondary: S.token
        ? [
            btn("退出登录", function () {
              setToken("");
              closeDialog();
              refreshSession().then(function () {
                poll(true);
              });
            }),
          ]
        : null,
    });
    setTimeout(function () {
      tok.focus();
    }, 50);
  }

  // ------------------------------------------------------------------
  // 对话框
  // ------------------------------------------------------------------
  function dialogOpen() {
    return $("dlg").open;
  }
  function closeDialog() {
    var d = $("dlg");
    if (d.open) d.close();
  }
  /** opts: title, body(Node|Node[]), okText, okClass, onOk(返回 Promise，抛错则显示在对话框内), secondary(按钮数组), wide */
  function showDialog(opts) {
    var d = $("dlg");
    var body = $("dlgBody");
    var msg = h("div");
    var ok = opts.onOk ? btn(opts.okText || "确定", null, "primary " + (opts.okClass || "")) : null;
    var main = h("div", { class: "dlg-main" }, opts.body, msg);
    body.replaceChildren(
      h("div", { class: "dlg-head" }, h("h2", null, opts.title), btn("关闭", closeDialog)),
      main,
      h("div", { class: "dlg-foot" }, opts.secondary || null, btn(opts.onOk ? "取消" : "关闭", closeDialog), ok),
    );
    if (ok) {
      ok.addEventListener("click", function () {
        msg.replaceChildren();
        ok.disabled = true;
        var oldText = ok.textContent;
        ok.textContent = "处理中…";
        Promise.resolve()
          .then(opts.onOk)
          .then(function (keepOpen) {
            if (keepOpen !== true) closeDialog();
          })
          .catch(function (e) {
            msg.replaceChildren(h("div", { class: "msg bad" }, e.message || String(e)));
          })
          .finally(function () {
            ok.disabled = false;
            ok.textContent = oldText;
          });
      });
    }
    if (!d.open) d.showModal();
    main.scrollTop = 0;
    return { main: main, msg: msg, ok: ok };
  }
  /** 带确认的操作：opts.title, message, confirmText(需要输入的文字), reason(是否要填原因), reasonLabel, danger, run(value) */
  function confirmAction(opts) {
    var input = opts.confirmText ? h("input", { type: "text", placeholder: opts.confirmText, autocomplete: "off" }) : null;
    var reason = opts.reason ? h("textarea", { placeholder: opts.reasonPlaceholder || "" }) : null;
    showDialog({
      title: opts.title,
      body: [
        opts.message ? (opts.message instanceof Node ? opts.message : h("p", null, opts.message)) : null,
        opts.extra || null,
        reason ? h("label", { class: "field" }, h("span", null, opts.reasonLabel || "原因"), reason) : null,
        input ? h("label", { class: "field" }, h("span", null, "请输入 " + opts.confirmText + " 确认"), input) : null,
      ],
      okText: opts.okText || "确认",
      okClass: opts.danger ? "danger solid" : "",
      onOk: function () {
        if (input && input.value.trim() !== opts.confirmText) throw new Error("输入的内容不一致");
        if (reason && opts.reasonRequired && !reason.value.trim()) throw new Error("请填写" + (opts.reasonLabel || "原因"));
        return opts.run({ confirm: input ? input.value.trim() : "", reason: reason ? reason.value.trim() : "" }).then(function (r) {
          if (opts.done) opts.done(r);
          poll(true);
          if (S.tab === "audit") loadAudit();
        });
      },
    });
    if (input) setTimeout(function () { input.focus(); }, 50);
  }

  // ------------------------------------------------------------------
  // 轮询与渲染
  // ------------------------------------------------------------------
  var polling = false;
  function poll(force) {
    if (polling && !force) return Promise.resolve();
    polling = true;
    var p = S.session ? Promise.resolve(S.session) : refreshSession();
    return p
      .then(function (s) {
        if (!s.role) {
          renderNeedLogin();
          return;
        }
        return api("GET", "/api/console/state").then(function (d) {
          S.data = d;
          $("clock").textContent = d.status.当前时间 + "（北京时间）";
          renderBanner();
          renderTabs();
          if (LIVE_TABS[S.tab] || !$("view").dataset.tab || $("view").dataset.tab !== S.tab) renderView();
        });
      })
      .catch(function (e) {
        if (e.status === 401) {
          S.session = null;
          renderNeedLogin();
        } else if (e.status === 429) {
          $("view").replaceChildren(h("div", { class: "msg bad" }, e.message));
        } else {
          $("banner").replaceChildren(h("div", { class: "banner bad" }, "连接机器人失败：" + (e.message || e)));
        }
      })
      .finally(function () {
        polling = false;
      });
  }

  function renderNeedLogin() {
    renderHeader();
    $("tabs").replaceChildren();
    $("view").dataset.tab = "";
    $("view").replaceChildren(card("需要口令", h("div", null, h("p", null, "查看状态需要口令（STATUS_TOKEN 或 CONSOLE_TOKEN）。"), btn("登录", openLogin, "primary"))));
  }

  function renderBanner() {
    var c = S.data.control;
    var out = [];
    if (S.session && !S.session.controlEnabled) out.push(h("div", { class: "banner info" }, "控制台只读：" + (S.session.controlProblem || "")));
    else if (S.session && S.session.role !== "control") out.push(h("div", { class: "banner info" }, "当前为只读，使用控制口令登录后可操作。", btn("登录", openLogin)));
    if (c.halted) {
      out.push(
        h(
          "div",
          { class: "banner bad" },
          h("strong", null, "全局已停止新挂单"),
          h("span", null, c.halted.reason + "（" + c.halted.since + " 起）"),
          canControl() ? btn("解除停止", doResume) : null,
        ),
      );
    }
    if (c.configErrors && c.configErrors.length) out.push(h("div", { class: "banner warn" }, "有配对配置无法加载：" + c.configErrors.map(function (x) { return x.id + "（" + x.error + "）"; }).join("；")));
    $("banner").replaceChildren.apply($("banner"), out);
  }

  function renderTabs() {
    var review = (S.data.control.review || []).filter(function (r) { return r.status === "PENDING_REVIEW"; }).length;
    $("tabs").replaceChildren.apply(
      $("tabs"),
      TABS.map(function (t) {
        return h(
          "button",
          {
            type: "button",
            class: "tab",
            role: "tab",
            "aria-selected": S.tab === t[0] ? "true" : "false",
            onclick: function () {
              S.tab = t[0];
              sset("localStorage", "console.tab", t[0]);
              renderTabs();
              renderView();
            },
          },
          t[1],
          t[0] === "review" && review ? h("span", { class: "count" }, review) : null,
        );
      }),
    );
  }

  function renderView() {
    var v = $("view");
    v.dataset.tab = S.tab;
    var content;
    try {
      if (S.tab === "overview") content = viewOverview();
      else if (S.tab === "pairs") content = viewPairs();
      else if (S.tab === "review") content = viewReview();
      else if (S.tab === "params") content = viewGlobalParams();
      else if (S.tab === "stats") content = viewStats();
      else if (S.tab === "audit") content = viewAudit();
      else content = viewOverview();
    } catch (e) {
      content = h("div", { class: "msg bad" }, "页面渲染出错：" + e.message);
    }
    v.replaceChildren(content);
  }

  // ------------------------------------------------------------------
  // 总览
  // ------------------------------------------------------------------
  function connBox(s) {
    var rows = [];
    ["polymarket", "predict"].forEach(function (v) {
      var md = s.行情连接[v];
      var tr = s.交易连接[v] || {};
      rows.push([
        VENUE[v],
        h(
          "span",
          null,
          dot(md === true ? "ok" : md === false ? "bad" : "warn", "行情 " + (md === true ? "在线" : md === false ? "断开" : md)),
          "  ",
          dot(tr.userStreamUp ? "ok" : "bad", "成交推送 " + (tr.userStreamUp ? "在线" : "断开")),
          "  ",
          dot(tr.authOk ? "ok" : "bad", "认证 " + (tr.authOk ? "正常" : "异常")),
          tr.lastError ? h("div", { class: "hint bad" }, tr.lastError) : null,
        ),
      ]);
    });
    return kv(rows);
  }
  function balanceBox(s) {
    return kv(
      ["polymarket", "predict"].map(function (v) {
        var b = s.余额[v];
        return [VENUE[v], b ? "可用 " + b.可用 + "（扣除本系统占用后 " + b.扣除本系统其他占用后 + "），余额 " + b.余额 + "，更新 " + b.更新 : "未获取"];
      }),
    );
  }
  function viewOverview() {
    var s = S.data.status;
    var c = S.data.control;
    var haltBox = c.halted
      ? h("div", null, h("div", { class: "bad" }, "已停止新挂单：" + c.halted.reason), h("div", { class: "hint" }, "开始于 " + c.halted.since + "；补单、对账与风控仍在运行"), canControl() ? h("div", { class: "row mt8" }, btn("解除停止", doResume, "primary")) : null)
      : h(
          "div",
          null,
          h("div", { class: "ok" }, "正常：允许新挂单"),
          h("div", { class: "hint" }, "停止后会撤掉全部挂单、不再新挂；已有敞口照常补单，对账与风控继续运行"),
          canControl() ? h("div", { class: "row mt8" }, btn("停止全部新挂单", doHalt, "danger solid big")) : null,
        );
    var pairRows = c.pairs.map(function (p) {
      var sp = statusOf(p.id);
      return {
        配对: p.id,
        比赛: p.labels ? p.labels.A + " vs " + p.labels.B : "-",
        方向: directionText(p),
        挂单: sp ? sp.挂单状态 : p.mode || "-",
        敞口: sp ? sp.敞口状态 : p.exposureMode || "-",
        净敞口: p.netExposure,
        锁定盈亏: sp ? sp.盈亏.锁定费后盈亏 : "-",
        开赛: p.startTime || "-",
        核对: VERIFY[p.verifyStatus] ? VERIFY[p.verifyStatus][0] : p.verifyStatus || "-",
        可挂单: p.tradeable ? "是" : "否：" + (p.blockReason || ""),
      };
    });
    return h(
      "div",
      null,
      h(
        "div",
        { class: "grid" },
        card("运行", kv([["模式", s.模式], ["启动时间", s.启动时间], ["当日亏损（美元）", s.当日亏损], ["配对数", c.pairs.length]])),
        card("全局开关", haltBox),
        card("连接", connBox(s)),
        card("余额", balanceBox(s)),
      ),
      s.平台阻断 && s.平台阻断.length ? h("div", null, h("h2", null, "平台阻断"), card(null, table(s.平台阻断))) : null,
      h("h2", null, "配对概况"),
      card(null, table(pairRows)),
      h("h2", null, "最近告警"),
      card(null, table((s.告警 || []).slice(0, 15))),
    );
  }

  function statusOf(id) {
    var list = (S.data && S.data.status.配对) || [];
    for (var i = 0; i < list.length; i++) if (list[i].配对 === id) return list[i];
    return null;
  }
  function directionText(p) {
    if (!p.labels || !p.makerOutcome) return VENUE[p.makerVenue] + " 挂单";
    var other = p.makerOutcome === "A" ? "B" : "A";
    var hv = p.makerVenue === "predict" ? "polymarket" : "predict";
    return VENUE[p.makerVenue] + " 挂买 " + p.labels[p.makerOutcome] + " → " + VENUE[hv] + " 买 " + p.labels[other];
  }

  // ------------------------------------------------------------------
  // 配对
  // ------------------------------------------------------------------
  function viewPairs() {
    var c = S.data.control;
    var head = h(
      "div",
      { class: "section-head" },
      h("h2", null, "配对（" + c.pairs.length + "）"),
      canControl() ? btn("新增配对", function () { openAddPair(null); }, "primary") : null,
      canControl() ? btn("发现候选配对", openDiscover) : null,
      canControl() ? btn("全部对账", function () { doReconcile(null); }) : null,
    );
    var list = c.pairs.length ? c.pairs.map(pairCard) : [card(null, h("div", { class: "empty" }, "还没有配对。可以点“新增配对”或“发现候选配对”。"))];
    var deleted = c.deleted && c.deleted.length
      ? h(
          "div",
          null,
          h("h2", null, "已删除的配对"),
          card(
            null,
            table(
              c.deleted.map(function (d) {
                return {
                  配对: d.id,
                  来源: d.origin === "file" ? "pairs.yaml" : "控制台新增",
                  比赛: d.labels ? d.labels.A + " vs " + d.labels.B : "-",
                  Predict: "#" + d.predictMarketId,
                  操作: canControl() ? btn("恢复", function () { doRestore(d); }) : "-",
                };
              }),
            ),
          ),
        )
      : null;
    return h("div", null, head, list, deleted);
  }

  function pairCard(p) {
    var sp = statusOf(p.id);
    var v = VERIFY[p.verifyStatus] || [p.verifyStatus || "未核对", "warn"];
    var paused = p.pausedByConsole || !p.enabled;
    var head = h(
      "div",
      { class: "pair-head" },
      h("span", { class: "pair-id" }, p.id),
      p.labels ? h("span", null, p.labels.A + " vs " + p.labels.B) : null,
      badge(v[0], v[1]),
      paused ? badge(p.pausedByConsole ? "控制台已暂停" : "配置禁用", "warn") : null,
      p.tradeable ? badge("挂单中/可挂单", "ok") : badge("不挂新单", ""),
      p.inEmergency ? badge("紧急处理中", "bad") : null,
      p.hasParamOverrides ? badge("有控制台参数", "") : null,
      badge(p.origin === "file" ? "pairs.yaml" : "控制台新增", ""),
    );
    var actions = h(
      "div",
      { class: "actions" },
      canControl() ? (paused ? btn("恢复挂单", function () { doResumePair(p); }, "primary") : btn("暂停挂单", function () { doPausePair(p); }, "warn")) : null,
      canControl() ? btn("参数", function () { openPairParams(p.id); }) : null,
      btn(p.verifyStatus === "PENDING_REVIEW" && canControl() ? "审阅并批准" : "核对详情", function () { openReview(p.id); }),
      canControl() ? btn("重新核对", function () { doRecheck(p); }) : null,
      canControl() ? btn("对账", function () { doReconcile(p.id); }) : null,
      canControl() ? btn("确认持仓基线", function () { doAcceptPositions(p); }) : null,
      canControl() ? btn("删除", function () { doDelete(p); }, "danger", p.deleteBlockers.length ? "删除前需要：" + p.deleteBlockers.join("；") : "删除配对（历史记录保留）") : null,
    );
    var left = kv([
      ["方向", directionText(p)],
      ["挂单状态", sp ? sp.挂单状态 + (sp.挂单说明 && sp.挂单说明 !== p.blockReason ? "：" + sp.挂单说明 : "") : p.mode || "-"],
      !p.tradeable ? ["不挂单原因", h("span", { class: "warn" }, p.blockReason || "-")] : null,
      ["敞口状态", sp ? sp.敞口状态 + (sp.敞口说明 ? "：" + sp.敞口说明 : "") : p.exposureMode || "-"],
      ["净敞口（份）", sp ? sp.净敞口_份 + "（含在途补单预计 " + sp.含在途补单的预计敞口_份 + "）" : p.netExposure],
      sp && sp.裸仓开始 ? ["裸仓", h("span", { class: "bad" }, sp.裸仓开始)] : null,
      sp && sp.紧急处理 ? ["紧急处理", h("span", { class: "bad" }, sp.紧急处理.原因 + "（" + sp.紧急处理.开始 + "）")] : null,
      ["开赛时间", p.startTime || "-"],
      ["停止挂单时间", sp ? sp.停止挂单时间 : "-"],
      ["未结束订单 / 待结算成交", p.openOrders + " / " + p.pendingFills],
      p.note ? ["备注", p.note] : null,
    ]);
    var q = sp && sp.最近报价;
    var right = kv([
      ["已对冲份数", sp ? sp.盈亏.已对冲份数 : "-"],
      ["两腿净花费", sp ? sp.盈亏.两腿净花费 : "-"],
      ["费用合计", sp ? sp.盈亏.费用合计 + (sp.盈亏.其中估算费用 !== "0" && sp.盈亏.其中估算费用 !== "0.0000" ? "（含估算 " + sp.盈亏.其中估算费用 + "）" : "") : "-"],
      ["锁定费后盈亏", sp ? h("strong", null, sp.盈亏.锁定费后盈亏) : "-"],
      ["补单平均耗时", sp ? sp.补单耗时.平均 : "-"],
      ["最近报价", q ? (q.不挂单原因 ? (q.不挂单原因 === p.blockReason ? "未报价（见不挂单原因）" : "不挂单：" + q.不挂单原因) : q.价格 + " × " + q.数量 + "，盈利上限 " + q.盈利上限挂价 + "，对冲含费 " + q.对冲每份成本含费 + "，预期每份 " + q.预期每份利润) : "-"],
      ["市场", "Predict #" + p.predictMarketId + " / Polymarket " + p.polymarketConditionId.slice(0, 10) + "…"],
    ]);
    var more = sp
      ? h(
          "div",
          null,
          details(p.id + ":books", "盘口（前 5 档）", table(Object.keys(sp.盘口).map(function (k) {
            var b = sp.盘口[k];
            return { 品种: k, 延迟: b ? b.延迟 : "-", 买: b ? b.买.join("  ") : "-", 卖: b ? b.卖.join("  ") : "-" };
          }))),
          details(p.id + ":pos", "持仓", table(Object.keys(sp.持仓).map(function (venue) {
            return Object.assign({ 平台: VENUE[venue] || venue }, sp.持仓[venue]);
          }))),
          details(p.id + ":orders", "订单（最近 30 笔）", table(sp.订单)),
          details(p.id + ":fills", "成交（最近 30 笔）", table(sp.成交)),
          details(p.id + ":eps", "补单耗时（最近 10 次）", table(sp.补单耗时.最近)),
        )
      : null;
    return h("div", { class: "card pair" }, head, actions, h("div", { class: "pair-body" }, left, right), more);
  }

  function doHalt() {
    confirmAction({
      title: "停止全部新挂单",
      message: "会撤掉所有配对的挂单并停止新挂单。已有敞口照常补单，对账与风控继续运行。解除前不会自动恢复（重启后仍保持停止）。",
      reason: true,
      reasonLabel: "原因（写入操作记录）",
      danger: true,
      okText: "停止新挂单",
      run: function (v) {
        return api("POST", "/api/console/halt", { reason: v.reason });
      },
      done: function () {
        toast("已停止全部新挂单", "ok");
      },
    });
  }
  function doResume() {
    var c = S.data.control;
    confirmAction({
      title: "解除全局停止",
      message: "解除后，核对通过、未暂停的配对会按参数重新挂单。" + (c.halted ? "当前停止原因：" + c.halted.reason : ""),
      okText: "解除停止",
      run: function () {
        return api("POST", "/api/console/resume", {});
      },
      done: function () {
        toast("已解除全局停止", "ok");
      },
    });
  }
  function doPausePair(p) {
    confirmAction({
      title: "暂停配对 " + p.id,
      message: "撤掉该配对的挂单并停止新挂单；已有敞口照常补单。暂停状态会保存，重启后仍然有效。",
      reason: true,
      reasonLabel: "原因（可选）",
      okText: "暂停",
      run: function (v) {
        return api("POST", "/api/console/pairs/" + encodeURIComponent(p.id) + "/pause", { reason: v.reason });
      },
      done: function () {
        toast("已暂停 " + p.id, "ok");
      },
    });
  }
  function doResumePair(p) {
    confirmAction({
      title: "恢复配对 " + p.id,
      message: "恢复后按当前参数挂单。核对未通过或待审核的配对仍不会挂单（核对门禁不受影响）。",
      okText: "恢复挂单",
      run: function () {
        return api("POST", "/api/console/pairs/" + encodeURIComponent(p.id) + "/resume", {});
      },
      done: function (r) {
        toast(r.tradeable ? "已恢复 " + p.id : "已恢复，但仍不能挂单：" + (r.blockReason || ""), r.tradeable ? "ok" : "bad");
      },
    });
  }
  function doRecheck(p) {
    api("POST", "/api/console/pairs/" + encodeURIComponent(p.id) + "/recheck", {})
      .then(function (r) {
        toast("核对结果：" + (VERIFY[r.status] ? VERIFY[r.status][0] : r.status) + (r.changed ? "（规则/队伍/赛程有变化）" : "（无变化）"), r.status === "REJECTED" ? "bad" : "ok");
        poll(true);
      })
      .catch(function (e) {
        toast(e.message, "bad");
      });
  }
  function doReconcile(id) {
    toast(id ? "正在对账 " + id + "…" : "正在对账全部配对…");
    api("POST", id ? "/api/console/pairs/" + encodeURIComponent(id) + "/reconcile" : "/api/console/reconcile", {})
      .then(function (r) {
        var bad = r.reports.filter(function (x) { return !x.ok; });
        if (!bad.length) toast("对账完成：" + r.reports.length + " 个配对全部一致", "ok");
        else {
          showDialog({
            title: "对账结果",
            body: table(r.reports.map(function (x) {
              return { 配对: x.pairId, 结果: x.ok ? "一致" : "有问题", 查单: x.ordersChecked, 更新: x.ordersUpdated, 成交: x.fillsSeen, 孤儿挂单: x.orphanOrders, 持仓不一致: x.positionMismatches.map(function (m) { return m.venue + "/" + m.outcome + " 差 " + m.diff; }).join("；") || "-", 错误: x.errors.join("；") || "-" };
            })),
          });
        }
        poll(true);
      })
      .catch(function (e) {
        toast(e.message, "bad");
      });
  }
  function doAcceptPositions(p) {
    confirmAction({
      title: "确认持仓基线：" + p.id,
      message: "把“交易所当前持仓 − 台账持仓”的差额记为基线（例如账户里原本就有的持仓），然后重新对账。只有在核实差额来源后才这样做。需要先暂停该配对、等挂单撤完。",
      confirmText: p.id,
      danger: true,
      okText: "确认基线",
      run: function (v) {
        return api("POST", "/api/console/pairs/" + encodeURIComponent(p.id) + "/accept-positions", { confirm: v.confirm });
      },
      done: function (r) {
        toast(r.reconcile.ok ? "已记录基线，对账一致" : "已记录基线，但对账仍有问题", r.reconcile.ok ? "ok" : "bad");
      },
    });
  }
  function doDelete(p) {
    var blockers = p.deleteBlockers || [];
    confirmAction({
      title: "删除配对 " + p.id,
      message: blockers.length
        ? h("div", { class: "msg warn" }, "当前还不能删除：" + blockers.join("；") + "。请先暂停该配对，等挂单撤完、补单完成、成交结算。")
        : "删除后不再管理该配对；历史订单、成交与统计保留，可在“已删除的配对”中恢复。",
      confirmText: p.id,
      danger: true,
      okText: "删除",
      run: function (v) {
        return api("POST", "/api/console/pairs/" + encodeURIComponent(p.id) + "/delete", { confirm: v.confirm });
      },
      done: function () {
        toast("已删除 " + p.id, "ok");
      },
    });
  }
  function doRestore(d) {
    confirmAction({
      title: "恢复配对 " + d.id,
      message: "会重新核对两边市场并加载该配对（沿用删除前的参数与暂停状态）。",
      okText: "恢复",
      run: function () {
        return api("POST", "/api/console/pairs/" + encodeURIComponent(d.id) + "/restore", {});
      },
      done: function (r) {
        toast("已恢复 " + d.id + "，核对状态：" + (VERIFY[r.status] ? VERIFY[r.status][0] : r.status), "ok");
      },
    });
  }

  // ------------------------------------------------------------------
  // 参数编辑（全局 / 配对共用）
  // ------------------------------------------------------------------
  function loadMeta() {
    if (S.meta) return Promise.resolve(S.meta);
    return api("GET", "/api/console/meta").then(function (m) {
      S.meta = m;
      return m;
    });
  }
  function getPath(obj, path) {
    var parts = path.split(".");
    var o = obj;
    for (var i = 0; i < parts.length; i++) {
      if (o === null || o === undefined || typeof o !== "object") return undefined;
      o = o[parts[i]];
    }
    return o;
  }
  function hasPath(obj, path) {
    var parts = path.split(".");
    var o = obj;
    for (var i = 0; i < parts.length; i++) {
      if (o === null || o === undefined || typeof o !== "object" || !Object.prototype.hasOwnProperty.call(o, parts[i])) return false;
      o = o[parts[i]];
    }
    return true;
  }
  function setPath(obj, path, v) {
    var parts = path.split(".");
    var o = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {};
      o = o[parts[i]];
    }
    o[parts[parts.length - 1]] = v;
  }
  function inputFor(f, cur) {
    var el;
    if (f.type === "enum") {
      el = h("select", null, f.options.map(function (o) { return h("option", { value: o[0] }, o[1]); }));
      el.value = String(cur);
    } else if (f.type === "bool") {
      el = h("select", null, h("option", { value: "true" }, "是"), h("option", { value: "false" }, "否"));
      el.value = cur === true ? "true" : "false";
    } else {
      el = h("input", { type: f.type === "text" ? "text" : "number", step: f.type === "int" ? "1" : "any", value: cur === null || cur === undefined ? "" : String(cur), placeholder: f.nullable ? "留空表示不设置" : "" });
    }
    el.dataset.orig = el.value;
    el.addEventListener("input", function () { el.classList.toggle("changed", el.value !== el.dataset.orig); });
    el.addEventListener("change", function () { el.classList.toggle("changed", el.value !== el.dataset.orig); });
    return el;
  }
  function parseInput(f, el) {
    var raw = el.value.trim();
    if (f.type === "enum") return raw;
    if (f.type === "bool") return raw === "true";
    if (raw === "") {
      if (f.nullable) return null;
      throw new Error(f.label + " 不能为空");
    }
    if (f.type === "text") return raw;
    var n = Number(raw);
    if (!isFinite(n)) throw new Error(f.label + " 需要数字");
    if (f.type === "int" && Math.floor(n) !== n) throw new Error(f.label + " 需要整数");
    return n;
  }
  /**
   * 参数表格：fields（字段说明）、prefix（strategy/risk）、effective（生效值对象）、sourceOf(path) 返回来源文字与是否控制台覆盖
   * 返回 { node, collect() → {set, unset, changes} }
   */
  function paramTable(groups) {
    var rows = [];
    var entries = [];
    groups.forEach(function (g) {
      g.fields.forEach(function (f) {
        var path = g.prefix + "." + f.key;
        var cur = getPath(g.effective, f.key);
        var src = g.sourceOf(path);
        var el = inputFor(f, cur);
        var reset = src.console ? h("input", { type: "checkbox", title: "删除控制台覆盖，恢复为下一层的值" }) : null;
        entries.push({ f: f, path: path, el: el, cur: cur, reset: reset });
        rows.push(
          h(
            "tr",
            null,
            h("td", null, h("div", null, f.label + (f.unit ? "（" + f.unit + "）" : "")), h("div", { class: "hint" }, path + (f.hint ? " · " + f.hint : "")), f.structural ? h("div", { class: "hint warn" }, "修改前该配对需要空闲（无订单、无敞口、无待结算成交）") : null),
            h("td", { class: "nowrap" }, fmt(cur)),
            h("td", null, h("span", { class: "src " + (src.console ? "console" : "") }, src.text)),
            h("td", { class: "input-cell" }, el),
            h("td", { class: "nowrap" }, reset ? h("label", null, reset, " 恢复") : null),
          ),
        );
      });
    });
    var node = h("div", { class: "scroll" }, h("table", null, h("thead", null, h("tr", null, h("th", null, "参数"), h("th", null, "生效值"), h("th", null, "来源"), h("th", null, "修改为"), h("th", null, "控制台覆盖"))), h("tbody", null, rows)));
    function collect() {
      var set = {};
      var unset = [];
      var changes = [];
      entries.forEach(function (e) {
        if (e.reset && e.reset.checked) {
          unset.push(e.path);
          changes.push(e.f.label + "：恢复为下一层的值");
          return;
        }
        if (e.el.value === e.el.dataset.orig) return;
        var v = parseInput(e.f, e.el);
        if (JSON.stringify(v) === JSON.stringify(e.cur === undefined ? null : e.cur)) return;
        setPath(set, e.path, v);
        changes.push(e.f.label + "：" + fmt(e.cur) + " → " + fmt(v));
      });
      return { set: set, unset: unset, changes: changes };
    }
    return { node: node, collect: collect };
  }
  function groupFields(fields, scope) {
    return fields.filter(function (f) { return scope === "global" || f.scope === "pair"; });
  }
  function changeList(changes) {
    return h("ul", null, changes.map(function (c) { return h("li", null, c); }));
  }
  function resultChanges(r) {
    if (!r || !r.changes || !r.changes.length) return "没有实际变化";
    return "已生效：" + r.changes.map(function (c) { return c.label + " " + fmt(c.from) + " → " + fmt(c.to); }).join("；");
  }

  // 全局参数页
  var globalState = { data: null, loading: false, error: null };
  function viewGlobalParams() {
    if (!globalState.data && !globalState.loading && !globalState.error) loadGlobal();
    var head = h("div", { class: "section-head" }, h("h2", null, "全局参数"), btn("刷新", loadGlobal));
    if (globalState.error) return h("div", null, head, h("div", { class: "msg bad" }, globalState.error));
    if (!globalState.data || !S.meta) return h("div", null, head, h("p", { class: "mut" }, "加载中…"));
    var g = globalState.data;
    var sourceOf = function (path) {
      if (hasPath(g.console, path)) return { text: "控制台（全局）", console: true };
      return { text: "config.yaml / 默认值", console: false };
    };
    var t = paramTable([
      { prefix: "strategy", fields: S.meta.strategyFields, effective: g.effective.strategy, sourceOf: sourceOf },
      { prefix: "risk", fields: S.meta.riskFields, effective: g.effective.risk, sourceOf: sourceOf },
    ]);
    var save = canControl()
      ? btn("保存修改", function () {
          var c;
          try {
            c = t.collect();
          } catch (e) {
            toast(e.message, "bad");
            return;
          }
          if (!c.changes.length) {
            toast("没有修改");
            return;
          }
          confirmAction({
            title: "确认修改全局参数",
            message: h("div", null, h("p", null, "以下修改会立即对所有配对生效（配对自己覆盖的参数除外），并保存到数据库，重启后仍然有效："), changeList(c.changes)),
            okText: "保存并生效",
            run: function () {
              return api("POST", "/api/console/global", { set: c.set, unset: c.unset });
            },
            done: function (r) {
              toast(resultChanges(r), "ok");
              loadGlobal();
            },
          });
        }, "primary")
      : null;
    return h(
      "div",
      null,
      head,
      h("p", { class: "hint" }, "生效顺序：默认值 → config.yaml → 控制台全局 → pairs.yaml 配对 → 控制台配对。控制台的修改保存在数据库里，修改配置文件不会覆盖它；需要以配置文件为准时勾选“恢复”。"),
      card(null, t.node),
      h("div", { class: "row mt8" }, save, canControl() ? null : h("span", { class: "hint" }, "只读：使用控制口令登录后可修改")),
    );
  }
  function loadGlobal() {
    globalState.loading = true;
    globalState.error = null;
    return Promise.all([loadMeta(), api("GET", "/api/console/global")])
      .then(function (r) {
        globalState.data = r[1];
      })
      .catch(function (e) {
        globalState.error = e.message;
      })
      .finally(function () {
        globalState.loading = false;
        if (S.tab === "params") renderView();
      });
  }

  // 配对参数对话框
  function openPairParams(id) {
    Promise.all([loadMeta(), api("GET", "/api/console/pairs/" + encodeURIComponent(id) + "/config")])
      .then(function (r) {
        var meta = r[0];
        var cfg = r[1];
        var L = cfg.layers;
        var sourceOf = function (path) {
          if (hasPath(L.pairConsole, path)) return { text: "控制台（本配对）", console: true };
          if (hasPath(L.pairBase, path)) return { text: cfg.origin === "file" ? "pairs.yaml" : "新增时填写", console: false };
          if (hasPath(L.globalConsole, path)) return { text: "控制台（全局）", console: false };
          return { text: "config.yaml / 默认值", console: false };
        };
        var t = paramTable([
          { prefix: "strategy", fields: groupFields(meta.strategyFields, "pair"), effective: cfg.effective.strategy, sourceOf: sourceOf },
          { prefix: "risk", fields: groupFields(meta.riskFields, "pair"), effective: cfg.effective.risk, sourceOf: sourceOf },
        ]);
        var labels = cfg.labels || { A: "A 队", B: "B 队" };
        var curDir = cfg.effective.maker.venue + ":" + cfg.effective.maker.outcome;
        var dir = h(
          "select",
          null,
          ["predict", "polymarket"].map(function (v) {
            return ["A", "B"].map(function (o) {
              var other = o === "A" ? "B" : "A";
              var hv = v === "predict" ? "polymarket" : "predict";
              return h("option", { value: v + ":" + o, selected: curDir === v + ":" + o }, VENUE[v] + " 挂买 " + labels[o] + "，在 " + VENUE[hv] + " 买 " + labels[other] + " 对冲");
            });
          }),
        );
        dir.value = curDir;
        dir.dataset.orig = dir.value;
        dir.addEventListener("change", function () { dir.classList.toggle("changed", dir.value !== dir.dataset.orig); });
        var note = h("input", { type: "text", value: cfg.effective.note || "", maxlength: "500" });
        note.dataset.orig = note.value;
        var dirInfo = cfg.directionChange && !cfg.directionChange.ok ? h("div", { class: "hint warn" }, "当前不能改方向：" + cfg.directionChange.reasons.join("；")) : h("div", { class: "hint" }, "改方向需要该配对没有未结束订单和敞口（先暂停，等挂单撤完）");
        var dlg = showDialog({
          title: "配对参数：" + id,
          body: [
            h("p", { class: "hint" }, "修改立即生效并保存到数据库（重启后仍然有效）。来源一栏说明当前值来自哪一层；勾选“恢复”删除控制台覆盖。"),
            card("挂单方向", h("div", null, dir, dirInfo, hasPath(L.pairConsole, "maker") ? h("div", { class: "hint" }, "方向来自控制台覆盖（配置为 " + (L.pairBase.maker.venue + " " + (L.pairBase.maker.outcome || L.pairBase.maker.team)) + "）") : null)),
            card("备注", note),
            h("h2", null, "策略与风控"),
            t.node,
          ],
          okText: "保存并生效",
          onOk: function () {
            var c = t.collect();
            var set = c.set;
            if (dir.value !== dir.dataset.orig) {
              var parts = dir.value.split(":");
              set.maker = { venue: parts[0], outcome: parts[1] };
              c.changes.push("挂单方向：" + dir.options[dir.selectedIndex].textContent);
            }
            if (note.value !== note.dataset.orig) {
              set.note = note.value;
              c.changes.push("备注：" + note.value);
            }
            if (!c.changes.length) throw new Error("没有修改");
            return api("POST", "/api/console/pairs/" + encodeURIComponent(id) + "/params", { set: set, unset: c.unset }).then(function (r) {
              toast(resultChanges(r), "ok");
              poll(true);
            });
          },
          secondary: hasAnyOverride(L.pairConsole)
            ? [
                btn("清除全部控制台覆盖", function () {
                  closeDialog();
                  confirmAction({
                    title: "清除 " + id + " 的控制台参数",
                    message: "策略、风控、方向与备注恢复为 " + (cfg.origin === "file" ? "pairs.yaml" : "新增时") + " 的值（暂停状态不变）。",
                    okText: "清除",
                    run: function () {
                      return api("POST", "/api/console/pairs/" + encodeURIComponent(id) + "/reset", {});
                    },
                    done: function (r) {
                      toast(resultChanges(r), "ok");
                    },
                  });
                }, "warn"),
              ]
            : null,
        });
        return dlg;
      })
      .catch(function (e) {
        toast(e.message, "bad");
      });
  }
  function hasAnyOverride(p) {
    if (!p) return false;
    return Object.keys(p).some(function (k) { return k !== "enabled" && k !== "pausedReason"; });
  }

  // ------------------------------------------------------------------
  // 审核
  // ------------------------------------------------------------------
  function viewReview() {
    var list = S.data.control.review || [];
    return h(
      "div",
      null,
      h("div", { class: "section-head" }, h("h2", null, "需要处理的核对结果")),
      h("p", { class: "hint" }, "“待审核”可以在审阅检查项、结算情形与两边规则原文后人工批准；“未通过”存在硬性不符，不能批准。批准绑定当前规则版本，规则、队伍或赛程变化后需要重新批准。"),
      card(
        null,
        table(
          list.map(function (r) {
            var v = VERIFY[r.status] || [r.status, ""];
            return {
              配对: r.id,
              状态: badge(v[0], v[1]),
              比赛: r.labels ? r.labels.A + " vs " + r.labels.B : "-",
              开赛: r.startTime || "-",
              已添加: r.configured ? "是" : "否（发现的候选）",
              原因: r.reason || "-",
              操作: btn(r.status === "PENDING_REVIEW" && canControl() ? "审阅并批准" : "查看", function () { openReview(r.id); }),
            };
          }),
        ),
      ),
    );
  }
  function reviewBody(r) {
    var d = r.def;
    var levelCls = { pass: "ok", warn: "warn", fail: "bad" };
    var levelTxt = { pass: "通过", warn: "注意", fail: "不符" };
    var verdict = { consistent: ["一致", "ok"], mismatch: ["不一致", "bad"], unknown: ["无法判定", "warn"] };
    var clauses = r.clauses;
    var clauseRows = [];
    if (clauses) {
      [
        ["cancelled", "比赛取消"],
        ["tie", "平局"],
        ["postponeWindowHours", "延期窗口（小时）"],
        ["postponedBeyond", "超过延期窗口"],
        ["forfeitBeforeStart", "开赛前弃权"],
        ["forfeitAfterStart", "开赛后弃权"],
        ["notCompleted", "开赛后未完赛"],
        ["resolutionSources", "结算数据源"],
        ["mentionsSingleMap", "提到单局/单图"],
      ].forEach(function (k) {
        var a = clauses.predict[k[0]];
        var b = clauses.polymarket[k[0]];
        clauseRows.push({ 条款: k[1], Predict: Array.isArray(a) ? a.join(", ") : fmt(a), Polymarket: Array.isArray(b) ? b.join(", ") : fmt(b), 对比: JSON.stringify(a) === JSON.stringify(b) ? "相同" : h("span", { class: "warn" }, "不同") });
      });
    }
    return [
      kv([
        ["状态", badge((VERIFY[r.status] || [r.status])[0], (VERIFY[r.status] || ["", ""])[1])],
        r.statusReason ? ["说明", r.statusReason] : null,
        d ? ["比赛", d.labels.A + " vs " + d.labels.B + (d.game ? "（" + d.game + (d.bestOf ? "，BO" + d.bestOf : "") + "）" : "")] : null,
        d ? ["开赛时间", d.startTime] : null,
        d ? ["盘口类型", d.marketType] : null,
        d ? ["Predict", "#" + d.predict.marketId + " · " + d.predict.categorySlug + " · 费率 " + d.predict.feeRateBps + "bps" + (d.predict.isNegRisk ? " · negRisk" : "") + (d.predict.isYieldBearing ? " · yield-bearing" : "")] : null,
        d ? ["Polymarket", d.polymarket.conditionId + " · " + d.polymarket.version + (d.polymarket.negRisk ? " · negRisk" : "")] : null,
        r.predictQuestion ? ["Predict 标题", r.predictQuestion] : null,
        r.polymarketQuestion ? ["Polymarket 标题", r.polymarketQuestion] : null,
        r.approvedBy ? ["批准人", r.approvedBy] : null,
        ["规则版本", r.rulesHash ? r.rulesHash.slice(0, 16) + "…" : "-"],
      ]),
      h("h2", null, "检查项"),
      table(
        (r.checks || []).map(function (c) {
          return { 检查: c.label, 结果: badge(levelTxt[c.level] || c.level, levelCls[c.level]), 说明: c.detail };
        }),
      ),
      h("h2", null, "结算情形（两腿合计兑付应为 1）"),
      table(
        (r.scenarios || []).map(function (s) {
          var v = verdict[s.verdict] || [s.verdict, ""];
          return { 情形: s.label, Predict: s.predictLeg, Polymarket: s.polymarketLeg, 合计: s.total, 判定: badge(v[0], v[1]), 备注: s.note || "-" };
        }),
      ),
      clauseRows.length ? h("h2", null, "规则条款对比") : null,
      clauseRows.length ? table(clauseRows) : null,
      r.rules
        ? details("rules:" + r.id, "两边规则原文", h("div", { class: "two" }, h("div", null, h("div", { class: "hint" }, "Predict"), h("pre", { class: "rules" }, r.rules.predict)), h("div", null, h("div", { class: "hint" }, "Polymarket"), h("pre", { class: "rules" }, r.rules.polymarket))))
        : null,
    ];
  }
  function openReview(id) {
    api("GET", "/api/console/pairs/" + encodeURIComponent(id) + "/review")
      .then(function (r) {
        var canApprove = r.status === "PENDING_REVIEW" && canControl();
        var note = canApprove ? h("textarea", { placeholder: "例如：已逐条核对两边规则，延期窗口差异可接受，因为……" }) : null;
        showDialog({
          title: "核对详情：" + id,
          body: [
            reviewBody(r),
            canApprove
              ? card(
                  "人工批准",
                  h(
                    "div",
                    null,
                    h("p", { class: "hint" }, "批准前会用最新数据再核对一次；规则、队伍或赛程与你看到的不同会拒绝。批准只对当前规则版本有效。" + (r.configured ? "" : "该候选还没有添加为配对，批准后还需要在“配对”页添加。")),
                    h("label", { class: "field" }, h("span", null, "批准理由（必填，写入操作记录）"), note),
                  ),
                )
              : r.status === "REJECTED"
                ? h("div", { class: "msg bad" }, "存在硬性不符，不能批准。")
                : null,
          ],
          okText: canApprove ? "批准" : null,
          onOk: canApprove
            ? function () {
                if (!note.value.trim()) throw new Error("请填写批准理由");
                return api("POST", "/api/console/pairs/" + encodeURIComponent(id) + "/approve", { note: note.value.trim(), rulesHash: r.rulesHash }).then(function (res) {
                  toast(res.message || "已批准 " + id + (res.configured ? (res.tradeable ? "，开始按参数挂单" : "；仍不挂单：" + (res.blockReason || "")) : "（尚未添加为配对）"), "ok");
                  poll(true);
                });
              }
            : null,
        });
      })
      .catch(function (e) {
        toast(e.message, "bad");
      });
  }

  // ------------------------------------------------------------------
  // 新增配对 / 发现候选
  // ------------------------------------------------------------------
  function openAddPair(prefill) {
    var pfId = h("input", { type: "number", min: "1", step: "1", placeholder: "例如 437", value: prefill ? String(prefill.predictMarketId) : "" });
    var cond = h("input", { type: "text", placeholder: "0x + 64 位十六进制", value: prefill ? prefill.polymarketConditionId : "", class: "wide" });
    var result = h("div");
    var preview = null;
    var form = null;
    function runPreview() {
      result.replaceChildren(h("p", { class: "mut" }, "正在核对两边市场…"));
      preview = null;
      form = null;
      return api("POST", "/api/console/preview", { predictMarketId: pfId.value.trim(), polymarketConditionId: cond.value.trim() })
        .then(function (r) {
          preview = r;
          var parts = [];
          if (r.conflict) parts.push(h("div", { class: "msg bad" }, r.conflict));
          else if (r.status === "REJECTED") parts.push(h("div", { class: "msg bad" }, "未通过核对，不能添加：" + (r.statusReason || "")));
          else if (r.status === "PENDING_REVIEW") parts.push(h("div", { class: "msg warn" }, "待审核：可以添加，但在“审核”页人工批准前不会挂单。"));
          else parts.push(h("div", { class: "msg ok" }, "核对通过。"));
          if (r.canAdd) {
            form = addForm(r);
            parts.push(card("添加设置", form.node));
          }
          parts.push(details("preview", "核对详情（检查项、结算情形、规则原文）", h("div", null, reviewBody(r))));
          result.replaceChildren.apply(result, parts);
        })
        .catch(function (e) {
          result.replaceChildren(h("div", { class: "msg bad" }, e.message));
        });
    }
    showDialog({
      title: "新增配对",
      body: [
        h("p", { class: "hint" }, "先核对两边市场（整场胜负盘、队伍、赛制、开赛时间、各结算情形），通过或待审核的才能添加。添加后默认不挂单，确认参数后在配对卡片上点“恢复挂单”。"),
        h("div", { class: "two" }, h("label", { class: "field" }, h("span", null, "Predict 市场 ID"), pfId), h("label", { class: "field" }, h("span", null, "Polymarket conditionId"), cond)),
        h("div", { class: "row" }, btn("核对", runPreview, "primary")),
        result,
      ],
      okText: "添加",
      onOk: function () {
        if (!preview) throw new Error("请先核对");
        if (!preview.canAdd || !form) throw new Error("该配对不能添加");
        var body = form.collect();
        return api("POST", "/api/console/pairs", body).then(function (r) {
          toast("已添加 " + r.id + "（" + ((VERIFY[r.status] || [r.status])[0]) + "）" + (r.resubscribed ? "；已重新订阅成交推送，对账后恢复挂单" : ""), "ok");
          S.tab = "pairs";
          sset("localStorage", "console.tab", "pairs");
          poll(true);
        });
      },
    });
    if (prefill) runPreview();
  }
  function addForm(r) {
    var labels = r.def.labels;
    var id = h("input", { type: "text", value: r.suggestedId, maxlength: "64" });
    var dir = h(
      "select",
      null,
      ["predict", "polymarket"].map(function (v) {
        return ["A", "B"].map(function (o) {
          var other = o === "A" ? "B" : "A";
          var hv = v === "predict" ? "polymarket" : "predict";
          return h("option", { value: v + ":" + o }, VENUE[v] + " 挂买 " + labels[o] + "，在 " + VENUE[hv] + " 买 " + labels[other] + " 对冲");
        });
      }),
    );
    var size = h("input", { type: "number", step: "any", min: "0", placeholder: "留空沿用全局" });
    var mode = h("select", null, h("option", { value: "" }, "沿用全局"), h("option", { value: "auto" }, "买一加价，不超过盈利上限"), h("option", { value: "max" }, "盈利上限价"), h("option", { value: "fixed" }, "固定价"));
    var price = h("input", { type: "number", step: "any", min: "0", max: "1", placeholder: "固定价模式填写" });
    var minProfit = h("input", { type: "number", step: "any", placeholder: "留空沿用全局" });
    var enabled = h("input", { type: "checkbox" });
    var note = h("input", { type: "text", maxlength: "500" });
    var node = h(
      "div",
      null,
      h("div", { class: "two" }, h("label", { class: "field" }, h("span", null, "配对 ID"), id), h("label", { class: "field" }, h("span", null, "挂单方向"), dir)),
      h("div", { class: "two" }, h("label", { class: "field" }, h("span", null, "目标挂单份额"), size), h("label", { class: "field" }, h("span", null, "每对最低费后利润（美元）"), minProfit)),
      h("div", { class: "two" }, h("label", { class: "field" }, h("span", null, "挂单价格模式"), mode), h("label", { class: "field" }, h("span", null, "固定挂单价"), price)),
      h("label", { class: "field" }, h("span", null, "备注"), note),
      h("label", { class: "row" }, enabled, "添加后立即开始挂单（不勾选则先处于暂停，确认后手动恢复）"),
      h("p", { class: "hint" }, "其他参数沿用全局，添加后可在“参数”里逐项修改。"),
    );
    function collect() {
      var parts = dir.value.split(":");
      var strategy = {};
      if (size.value.trim()) strategy.sizeShares = Number(size.value);
      if (mode.value) strategy.priceMode = mode.value;
      if (price.value.trim()) strategy.price = Number(price.value);
      if (minProfit.value.trim()) strategy.minProfitPerShare = Number(minProfit.value);
      var body = {
        id: id.value.trim() || undefined,
        predictMarketId: Number(r.def.predict.marketId),
        polymarketConditionId: r.def.polymarket.conditionId,
        maker: { venue: parts[0], outcome: parts[1] },
        strategy: strategy,
        enabled: enabled.checked,
        rulesHash: r.rulesHash,
      };
      if (note.value.trim()) body.note = note.value.trim();
      return body;
    }
    return { node: node, collect: collect };
  }
  function openDiscover() {
    var box = h("div", null, h("p", { class: "mut" }, "正在遍历 Predict 电竞整场胜负盘并核对对应的 Polymarket 市场，可能需要几十秒…"));
    showDialog({ title: "发现候选配对", body: box });
    api("POST", "/api/console/discover", {})
      .then(function (r) {
        var rows = r.candidates
          .filter(function (c) { return c.status !== "REJECTED"; })
          .map(function (c) {
            var v = VERIFY[c.status] || [c.status, ""];
            return {
              状态: badge(v[0], v[1]),
              比赛: c.labels ? c.labels.A + " vs " + c.labels.B : c.question,
              开赛: c.startTime || "-",
              Predict: "#" + c.predictMarketId,
              已配置: c.configuredAs || "-",
              说明: c.reasons.join("；") || "-",
              操作: c.configuredAs ? "-" : btn("添加", function () { openAddPair(c); }),
            };
          });
        var rejected = r.candidates.filter(function (c) { return c.status === "REJECTED"; });
        box.replaceChildren(
          h("p", { class: "hint" }, "核对时间 " + r.at + "；共 " + r.candidates.length + " 个候选，下面列出通过或待审核的。"),
          table(rows),
          rejected.length ? details("discover:rejected", "未通过核对的候选（" + rejected.length + "）", table(rejected.map(function (c) { return { 比赛: c.labels ? c.labels.A + " vs " + c.labels.B : c.question, 开赛: c.startTime || "-", 原因: c.reasons.join("；") }; }))) : null,
          r.skipped && r.skipped.length ? details("discover:skipped", "跳过的市场", table(r.skipped.map(function (s) { return { 原因: s.reason, 数量: s.count }; }))) : null,
        );
      })
      .catch(function (e) {
        box.replaceChildren(h("div", { class: "msg bad" }, e.message));
      });
  }

  // ------------------------------------------------------------------
  // 统计与操作记录
  // ------------------------------------------------------------------
  var statsState = { data: null, error: null, at: 0, loading: false };
  function viewStats() {
    if (!statsState.loading && Date.now() - statsState.at > 15000) loadStats();
    var sel = h(
      "select",
      { onchange: function () { S.statsHours = sel.value; sset("localStorage", "console.statsHours", sel.value); statsState.data = null; statsState.error = null; loadStats(); } },
      [["24", "最近 24 小时"], ["168", "最近 7 天"], ["720", "最近 30 天"], ["", "全部"]].map(function (o) { return h("option", { value: o[0], selected: S.statsHours === o[0] }, o[1]); }),
    );
    var head = h("div", { class: "section-head" }, h("h2", null, "补单统计"), sel, btn("刷新", function () { statsState.error = null; loadStats(); }));
    var note = h("p", { class: "hint" }, "第一腿实际成交 → 第二腿实际成交的总耗时（交易所口径与本机口径），分段耗时、补单失败率与滑点。比较部署地区时看较慢的 P95。");
    if (statsState.error) return h("div", null, head, note, h("div", { class: "msg bad" }, statsState.error));
    if (!statsState.data) return h("div", null, head, note, h("p", { class: "mut" }, "加载中…"));
    var pairs = statsState.data.pairs;
    var ids = Object.keys(pairs);
    return h(
      "div",
      null,
      head,
      note,
      ids.length ? h("div", { class: "grid" }, ids.map(function (id) { return card(id, kv(Object.keys(pairs[id]).map(function (k) { return [k, pairs[id][k]]; }))); })) : card(null, h("div", { class: "empty" }, "暂无数据")),
    );
  }
  function loadStats() {
    statsState.at = Date.now();
    statsState.loading = true;
    return api("GET", "/api/console/stats" + (S.statsHours ? "?hours=" + encodeURIComponent(S.statsHours) : ""))
      .then(function (d) {
        statsState.data = d;
        statsState.error = null;
      })
      .catch(function (e) {
        statsState.error = e.message;
      })
      .finally(function () {
        statsState.loading = false;
        if (S.tab === "stats") renderView();
      });
  }
  var auditState = { data: null, error: null, at: 0, loading: false };
  function viewAudit() {
    if (!auditState.loading && Date.now() - auditState.at > 10000) loadAudit();
    var head = h("div", { class: "section-head" }, h("h2", null, "操作记录"), btn("刷新", loadAudit));
    if (auditState.error) return h("div", null, head, h("div", { class: "msg bad" }, auditState.error));
    if (!auditState.data) return h("div", null, head, h("p", { class: "mut" }, "加载中…"));
    return h(
      "div",
      null,
      head,
      h("p", { class: "hint" }, "控制台与命令行的每次控制操作（包括被拒绝的）都会记录。操作人为登录时填写的名字。"),
      card(
        null,
        table(
          auditState.data.map(function (a) {
            var detail = a.ok ? summarize(a.result) : (a.result && a.result.error) || "";
            return {
              时间: a.time,
              操作人: a.actor,
              来源: a.source === "cli" ? "命令行" : "网页",
              IP: a.ip || "-",
              操作: ACTIONS[a.action] || a.action,
              对象: a.target || "-",
              结果: a.ok ? badge("成功", "ok") : badge("未执行", "bad"),
              说明: detail || "-",
              参数: a.params && Object.keys(a.params).length ? JSON.stringify(a.params) : "-",
            };
          }),
        ),
      ),
    );
  }
  function summarize(r) {
    if (!r) return "";
    if (r.changes) return r.changes.map(function (c) { return c.label + " " + fmt(c.from) + " → " + fmt(c.to); }).join("；") || "没有实际变化";
    if (r.halted !== undefined) return r.alreadyHalted ? "之前已处于停止状态" : "已停止新挂单";
    if (r.previous !== undefined) return r.previous ? "原停止原因：" + r.previous.reason : "之前未停止";
    if (r.deleted) return "已删除";
    if (r.baseline) return "已记录基线；对账" + (r.reconcile && r.reconcile.ok ? "一致" : "仍有问题");
    if (r.reports) return r.reports.map(function (x) { return x.pairId + (x.ok ? " 一致" : " 有问题"); }).join("；");
    if (r.status) return "核对状态 " + ((VERIFY[r.status] || [r.status])[0]) + (r.tradeable === false ? "（不挂单）" : "");
    if (r.enabled !== undefined) return r.enabled ? "已恢复" + (r.tradeable === false ? "，但仍不挂单：" + (r.blockReason || "") : "") : "已暂停";
    return JSON.stringify(r).slice(0, 200);
  }
  function loadAudit() {
    auditState.at = Date.now();
    auditState.loading = true;
    return api("GET", "/api/console/audit?limit=300")
      .then(function (d) {
        auditState.data = d;
        auditState.error = null;
      })
      .catch(function (e) {
        auditState.error = e.message;
      })
      .finally(function () {
        auditState.loading = false;
        if (S.tab === "audit") renderView();
      });
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------
  $("loginBtn").addEventListener("click", openLogin);
  refreshSession()
    .then(function (s) {
      if (!s.role) openLogin();
      return poll(true);
    })
    .catch(function (e) {
      $("view").replaceChildren(h("div", { class: "msg bad" }, "连接机器人失败：" + e.message));
    });
  setInterval(function () {
    if (document.visibilityState === "visible") poll(false);
  }, 2000);
})();
