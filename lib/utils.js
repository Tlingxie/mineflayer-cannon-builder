/**
 * 工具函数模块
 */

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 带超时的 Promise 包装
function withTimeout (promise, ms, errorMsg = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ])
}

function hashString (value) {
  let hash = 0
  for (const ch of value) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  }
  return Math.abs(hash)
}

module.exports = {
  wait,
  withTimeout,
  hashString
}
