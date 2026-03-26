const PERSONA_LINES = {
  idle: [
    "先安静一会儿，等下一条动静。",
    "让我缓两秒，顺便盯着全局。",
    "现在风平浪静，正好整理下思路。",
    "我先待命，下一波来了就接上。",
  ],
  working: [
    "我还盯着进度，先把这段节奏稳住。",
    "这会儿别急，我在把手上的线头收拢。",
    "先继续推，等我把这一步看扎实。",
  ],
  thinking: [
    "让我再想十秒，这里还可以更顺一点。",
    "这个点我再捋一下，别把边界漏掉。",
    "先别催，我把思路拧顺就继续。",
  ],
  success: [
    "这步收住了，节奏不错。",
    "这一段已经落稳，可以往下推了。",
    "成了，先记一笔，继续往前走。",
  ],
  error: [
    "这里有点不对劲，我先把问题摁住。",
    "出了点岔子，先别慌，我来收口。",
    "这下得回头看一眼，把风险压住。",
  ],
  disconnect: [
    "连接断了一下，我先守在这里等它回来。",
    "信号掉了，我先盯着重连。",
    "先别急，链路抖了一下，我在看着。",
  ],
  reconnect: [
    "连上了，继续按刚才的节奏。",
    "连接恢复，咱们接着往下推。",
    "好了，链路回来了，我继续盯着。",
  ],
  request: [
    "新动静来了，我先接住。",
    "收到新的请求，我来跟一下。",
    "有新事情进来了，我先看一眼。",
  ],
};

export function getPersonaLines(category) {
  const key = String(category || "").trim();
  const lines = PERSONA_LINES[key];
  return Array.isArray(lines) ? lines.slice() : [];
}

export function hasPersonaCategory(category) {
  return getPersonaLines(category).length > 0;
}
