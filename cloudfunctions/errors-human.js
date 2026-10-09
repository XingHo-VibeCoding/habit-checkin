// ============ Day 23：三类错误的人话层（两个云函数共用） ============
//
// 【今天回答的问题：哪句裸报错改成了人话？】
//
// **改前**（catch 里一句）：
//     fail('UPSTREAM', String(e.message))
//
//   → 页面上的人看到的是这一句：
//     `request to https://habit-checkin-...failed, reason: getaddrinfo ENOTFOUND`
//     （或者 socket hang up / Parse Error: Unexpected token }）
//
// **改后**：
//     「数据库现在连不上。这是服务器那边的问题，不是你操作错了。
//       稍等一会儿再试；如果一直这样，请联系开发。」
//
// **为什么要专门做这一层**
//   `e.message` 是**给开发者看的**（里面有域名、errno、堆栈线索），
//   但页面上的用户只会看到它，然后一脸茫然—— 既不知道出了什么事，
//   也不知道该不该找谁。
//
//   而调试信息**不能丢**，所以我把它挪到日志里（log({ err })），
//   只是不再从响应里直接吐给人。
//   这条分界线是：**给人看的说人话，给排查看的留原文。**
//
// 【为什么单独一个文件，而不是两份抄一遍】
//   Day 17~20 每次改items 都要记得改 reminders，漏过一次。
//   两处措辞一旦漂移，同一件事就有两种说法，排查时更费劲。
//   抽出共享文件是唯一能让它们**永远一致**的做法。
//
// 【三类错误，各有固定说法】
//   1. 配置缺失（CONFIG_MISSING）：得有人去控制台开开关 —— 只有开发能做
//   2. 上游/网络失败（UPSTREAM）：服务器或网络的问题 —— 用户等就行
//   3. 输入不对（VALIDATION）：      用户自己能改 —— 说得清是哪一改错了
//
//   为什么必须分开：这三类的**下一步动作完全不同**。
//   合成一个「操作失败」等于把排查成本推给了不该管这件事的人。

// ---------- ① 输入不对：用户自己能改，要说清是哪一改错了 ----------
function humanValidation(msg) {
  return msg || '你填的内容有问题，请检查后重试。';
}

// ---------- ② 配置缺失：只有开发能修，要说清去哪儿开 ----------
function humanConfig(hint) {
  var vars = (hint && hint.vars && hint.vars.length)
    ? hint.vars.join(' / ')
    : 'CLOUDBASE_APIKEY';
  return '服务器还没配置好数据库访问凭证。这是部署环节漏了一步，不是你操作的问题。' +
    '需要开发者在 CloudBase 控制台的函数配置里开启 API Key' +
    '（或加环境变量 ' + vars + '）。';
}

// ---------- ③ 上游/网络失败：用户能做的只有等 ----------
//
// ⚠️ 关键约束：**这里绝不能把 e.message 拼进来**。
//   裸报错里常带内网域名、端口、errno，甚至偶尔混进凭据片段——
//   那是给排查看的，不是给页面上的用户看的。
//
// ⚠️ 也不要因为「统一」把上游约束报错也抹平：
//   23505（主键冲突）那类**必须**让用户看到详情 —— 那里面有「id 重复了」这类
//   他必须知道的信息。判据：**这个信息用户能不能据此自己改正？**
//   能 → 说清楚；不能 → 一律人话。
function humanUpstream(e, logger) {
  var raw = String((e && e.message) || e || 'unknown');

  // 原文只进日志，不进响应。日志在云端自己那侧，不对外暴露。
  if (typeof logger === 'function') {
    logger({ st: 'upstream_detail', err: raw });
  }

  var lower = raw.toLowerCase();
  // 分类是为了让提示更贴合真实情况，但**措辞不暴露任何技术细节**。
  if (lower.indexOf('timeout') >= 0 || lower.indexOf('etimedout') >= 0) {
    return '数据库响应超时了，可能是网络波动。稍等几秒再试一次通常就好了。';
  }
  if (lower.indexOf('enotfound') >= 0 || lower.indexOf('getaddrinfo') >= 0) {
    return '数据库现在连不上（域名解析失败）。这是服务器或网络的问题，' +
      '不是你操作错了 —— 稍后再试，如果一直不行请联系开发。';
  }
  if (lower.indexOf('econnrefused') >= 0 || lower.indexOf('econnreset') >= 0 ||
      lower.indexOf('socket hang up') >= 0) {
    return '数据库连接中断了。这是服务器那边的问题，你的操作没问题。稍后重试。';
  }
  if (lower.indexOf('json') >= 0 || lower.indexOf('parse') >= 0 || lower.indexOf('unexpected token') >= 0) {
    return '服务器返回的数据格式不对。这是后端的bug，不是你操作的问题，请联系开发。';
  }
  return '数据库现在连不上。这是服务器那边的问题，不是你操作错了。' +
    '稍等一会儿再试；如果一直这样，请联系开发。';
}

module.exports = {
  humanValidation: humanValidation,
  humanConfig: humanConfig,
  humanUpstream: humanUpstream
};