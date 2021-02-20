const fs = require('fs-extra')
const path = require('path')
const { URL } = require('url')
const { app, ipcMain } = require('electron')
const { sleep, request, detectGameLocale, sendMsg, readJSON, saveJSON } = require('./utils')

const order = ['301', '302', '200', '100']

let GachaTypesUrl
let GachaLogBaseUrl
let uid = 0
let lang = ''
let localData = null

const saveData = async (data) => {
  const obj = Object.assign({}, data)
  obj.result = [...obj.result]
  obj.typeMap = [...obj.typeMap]
  await saveJSON(`gacha-list-${uid}.json`, obj)
  await saveJSON('gacha-list.json', obj)
}

const itemTypeFixMap = new Map([
  ['Limited Character', '301'],
  ['Weapon', '302'],
  ['Permanent', '200'],
  ['Novice', '100']
])

const defaultTypeMap = new Map([
  ['301', 'Limited Character'],
  ['302', 'Weapon'],
  ['200', 'Permanent'],
  ['100', 'Novice']
])

const readData = async () => {
  try {
    const obj = await readJSON(`gacha-list${uid ? `-${uid}` : ''}.json`)
    if (!obj) return false
    obj.result.forEach(item => {
      if (itemTypeFixMap.has(item[0])) {
        item[0] = itemTypeFixMap.get(item[0])
      }
    })
    obj.typeMap = obj.typeMap ? new Map(obj.typeMap) : defaultTypeMap
    obj.result = new Map(obj.result)
    localData = obj
    return obj
  } catch (e) {
    return false
  }
}

const sortData = (data) => {
  return data.map(item => {
    const [time, name, type, rank] = item
    return {
      time, name, type, rank,
      timestamp: new Date(time)
    }
  }).sort((a, b) => a.timestamp - b.timestamp)
    .map(item => {
      const { time, name, type, rank } = item
      return [time, name, type, rank]
    })
}

const mergeList = (a, b) => {
  if (!a || !a.length) return b || []
  if (!b || !b.length) return a
  const minA = new Date(a[0][0]).getTime()
  let pos = b.length
  for (let i = 0; i < b.length; i++) {
    const time = new Date(b[i][0]).getTime()
    if (time >= minA) {
      pos = i
      break
    }
  }
  return b.slice(0, pos).concat(a)
}

const mergeData = (local, origin) => {
  if (local && local.result) {
    const localResult = local.result
    const localUid = local.uid
    const originUid = origin.uid
    if (localUid !== originUid) return origin.result
    const originResult = new Map()
    for (let [key, value] of origin.result) {
      const newVal = mergeList(value, localResult.get(key))
      originResult.set(key, newVal)
    }
  }
  return origin.result
}

const readLog = async () => {
  try {
    const userPath = app.getPath('home')
    const gameNames = await detectGameLocale(userPath)
    if (!gameNames.length) {
      sendMsg('The game log is not found, confirm whether the wish history has been opened ')
      return false
    }
    const promises = gameNames.map(async name => {
      const logText = await fs.readFile(`${userPath}/AppData/LocalLow/miHoYo/${name}/output_log.txt`, 'utf8')
      const arr = logText.match(/^OnGetWebViewPageFinish:https:\/\/.+\?.+?(?:#.+)?$/mg)
      if (arr && arr.length) {
        return arr[arr.length - 1].replace('OnGetWebViewPageFinish:', '')
      }
    })
    const result = await Promise.all(promises)
    for (let url of result) {
      if (url) {
        return url
      }
    }
    sendMsg('URL not found')
    return false
  } catch (e) {
    sendMsg('Failed to read log')
    return false
  }
}

const getGachaLog = async (key, page, name, retryCount = 5) => {
  try {
    const res = await request(
      GachaLogBaseUrl + `&gacha_type=${key}` + `&page=${page}` + `&size=${20}`
    )
    return res.data.list
  } catch (e) {
    if (retryCount) {
      sendMsg(`Getting ${name} #${page} Failed ${6 - retryCount} - Retry`)
      await sleep(5)
      retryCount--
      return await getGachaLog(key, page, name, retryCount)
    } else {
      sendMsg(`Getting ${name} #${page} Failed, retries exceeded `)
      throw e
    }
  }
}

const getGachaLogs = async (name, key) => {
  let page = 1
  let data = []
  let res = []
  do {
    if (page % 10 === 0) {
      sendMsg(`Getting ${name} page #${page}...`)
      await sleep(1)
    }
    sendMsg(`Getting ${name} page #${page}`)
    res = await getGachaLog(key, page, name)
    if (!uid && res.length) {
      uid = res[0].uid
    }
    data.push(...res)
    page += 1
  } while (res.length > 0)
  return data
}

const getData = async () => {
  const result = new Map()
  const typeMap = new Map()
  const url = await readLog()
  if (!url) return false
  const { searchParams } = new URL(url)
  if (!searchParams.get('authkey')) {
    sendMsg('Failed to get the authkey from the URL')
    return false
  }
  if (localData && localData.lang) {
    searchParams.set('lang', localData.lang)
  }
  lang = searchParams.get('lang')
  const queryString = searchParams.toString()
  GachaTypesUrl = `https://hk4e-api.mihoyo.com/event/gacha_info/api/getConfigList?${queryString}`
  GachaLogBaseUrl = `https://hk4e-api.mihoyo.com/event/gacha_info/api/getGachaLog?${queryString}`
  sendMsg('Getting the type of banner')
  const res = await request(GachaTypesUrl)
  if (res.retcode !== 0) {
    sendMsg(res.message)
    return false
  }
  const gachaTypes = res.data.gacha_type_list
  const orderedGachaTypes = []
  order.forEach(key => {
    const index = gachaTypes.findIndex(item => item.key === key)
    if (index !== -1) {
      orderedGachaTypes.push(gachaTypes.splice(index, 1)[0])
    }
  })
  orderedGachaTypes.push(...gachaTypes)
  sendMsg('Succeeded in getting the type of banner')
  for (const type of orderedGachaTypes) {
    const logs = (await getGachaLogs(type.name, type.key)).map((item) => {
      return [item.time, item.name, item.item_type, parseInt(item.rank_type)]
    })
    logs.reverse()
    typeMap.set(type.key, type.name)
    result.set(type.key, logs)
  }
  const data = { result, time: Date.now(), typeMap, uid, lang }
  await readData()
  const mergedResult = mergeData(localData, data)
  data.result = mergedResult
  await saveData(data)
  return data
}

ipcMain.handle('FETCH_DATA', async () => {
  try {
    const data = await getData()
    return data
  } catch (e) {
    sendMsg(e, 'ERROR')
    console.error(e)
  }
  return false
})

ipcMain.handle('READ_DATA', async () => {
  const data = await readData()
  return data
})

exports.readData = readData