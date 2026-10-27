import type { FastifyPluginAsync } from 'fastify'
import type { Prisma } from '../../generated/prisma/client.js'
import { prisma } from '../../prisma.js'
import { ApiCode } from '../../lib/codes.js'
import { fail, ok } from '../../lib/reply.js'
import { pushLog } from '../../lib/log.js'
import { toDictItem, toDictType } from '../../lib/dto.js'
import { currentAdmin } from '../../lib/whoami.js'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 字典编码的格式：小写字母开头，只能是小写字母/数字/下划线 */
const CODE_RE = /^[a-z][a-z0-9_]{1,30}$/

/**
 * 字典。前缀 /api/admin
 *
 * ⚠️ 只收「加一个值不需要改代码」的枚举。
 *    客户状态、卡密状态、管理员角色、日志动作类型**不进这里** ——
 *    它们被后端的 if 引用，塞进来只会造出一个选得动、但什么都不发生的假旋钮。
 */
export const adminDictRoutes: FastifyPluginAsync = async (app) => {
  /** GET /api/admin/dicts —— 一次拿全部（类型 + 数据项），数据量小，没必要拆两个请求 */
  app.get('/dicts', async () => {
    const [types, items] = await Promise.all([
      prisma.dictType.findMany({ orderBy: { code: 'asc' } }),
      prisma.dictItem.findMany({ orderBy: [{ typeCode: 'asc' }, { sort: 'asc' }, { id: 'asc' }] })
    ])

    const byType = new Map<string, typeof items>()
    for (const item of items) {
      const list = byType.get(item.typeCode) ?? []
      list.push(item)
      byType.set(item.typeCode, list)
    }

    return ok(
      types.map((t) => ({
        type: toDictType(t),
        items: (byType.get(t.code) ?? []).map(toDictItem)
      }))
    )
  })

  /** POST /api/admin/dicts —— 新建一个字典类型 */
  app.post('/dicts', async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>
    const code = textOf(body.code)
    const name = textOf(body.name)

    if (!code || !name) return fail(ApiCode.INVALID_PARAM, '编码和名称都要填')
    if (!CODE_RE.test(code)) {
      return fail(ApiCode.INVALID_PARAM, '编码只能用小写字母、数字和下划线，且以字母开头')
    }
    if (await prisma.dictType.findUnique({ where: { code } })) {
      return fail(ApiCode.INVALID_PARAM, '这个编码已经存在')
    }

    const admin = await currentAdmin(request)

    const type = await prisma.$transaction(async (tx) => {
      const row = await tx.dictType.create({
        data: { code, name, remark: textOf(body.remark) }
      })
      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'dict.create',
          targetType: 'dict',
          targetId: null,
          targetName: `${name}（${code}）`,
          detail: '新建字典类型',
          ip: request.ip
        },
        tx
      )
      return row
    })

    return ok({ type: toDictType(type), items: [] })
  })

  /** POST /api/admin/dicts/:code/items —— 新增数据项 */
  app.post('/dicts/:code/items', async (request) => {
    const code = (request.params as { code: string }).code
    const type = await prisma.dictType.findUnique({ where: { code } })
    if (!type) return fail(ApiCode.NOT_FOUND, '字典类型不存在')

    const body = (request.body ?? {}) as Record<string, unknown>
    const label = textOf(body.label)
    const value = textOf(body.value)

    if (!label || !value) return fail(ApiCode.INVALID_PARAM, '标签和值都要填')
    if (await prisma.dictItem.findFirst({ where: { typeCode: code, value } })) {
      return fail(ApiCode.INVALID_PARAM, '这个值已经存在')
    }

    const admin = await currentAdmin(request)
    const sort = Number.isFinite(Number(body.sort)) && body.sort !== undefined ? Math.floor(Number(body.sort)) : 100

    const item = await prisma.$transaction(async (tx) => {
      const row = await tx.dictItem.create({
        data: { typeCode: code, label, value, sort, remark: textOf(body.remark) }
      })
      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'dict.update',
          targetType: 'dict',
          targetId: row.id,
          targetName: `${type.name} / ${label}`,
          detail: `新增数据项 ${label}（${value}）`,
          ip: request.ip
        },
        tx
      )
      return row
    })

    return ok(toDictItem(item))
  })

  /** PATCH /api/admin/dicts/items/:id —— 改标签 / 值 / 排序 / 启用停用 / 备注 */
  app.patch('/dicts/items/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '字典项 id 不对')

    const item = await prisma.dictItem.findUnique({ where: { id } })
    if (!item) return fail(ApiCode.NOT_FOUND, '字典项不存在')

    const type = await prisma.dictType.findUnique({ where: { code: item.typeCode } })
    if (!type) return fail(ApiCode.NOT_FOUND, '字典类型不存在')

    const body = (request.body ?? {}) as Record<string, unknown>
    const data: Prisma.DictItemUpdateInput = {}
    const changes: string[] = []

    const nextLabel = textOf(body.label)
    if (nextLabel && nextLabel !== item.label) {
      changes.push(`标签 ${item.label} → ${nextLabel}`)
      data.label = nextLabel
    }

    const nextValue = textOf(body.value)
    if (nextValue && nextValue !== item.value) {
      const clash = await prisma.dictItem.findFirst({
        where: { typeCode: item.typeCode, value: nextValue, id: { not: id } }
      })
      if (clash) return fail(ApiCode.INVALID_PARAM, '这个值已经存在')
      changes.push(`值 ${item.value} → ${nextValue}`)
      data.value = nextValue
    }

    if (typeof body.sort === 'number' && Number.isFinite(body.sort) && body.sort !== item.sort) {
      changes.push(`排序 ${item.sort} → ${Math.floor(body.sort)}`)
      data.sort = Math.floor(body.sort)
    }

    if (typeof body.enabled === 'boolean' && body.enabled !== item.enabled) {
      changes.push(body.enabled ? '启用' : '停用')
      data.enabled = body.enabled
    }

    if (typeof body.remark === 'string' && body.remark.trim() !== item.remark) {
      data.remark = body.remark.trim()
      changes.push('改了备注')
    }

    // 什么都没变 —— 不写库，也不写日志
    if (changes.length === 0) return ok(toDictItem(item))

    const admin = await currentAdmin(request)

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.dictItem.update({ where: { id }, data })
      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'dict.update',
          targetType: 'dict',
          targetId: row.id,
          targetName: `${type.name} / ${row.label}`,
          detail: changes.join('；'),
          ip: request.ip
        },
        tx
      )
      return row
    })

    return ok(toDictItem(updated))
  })

  /** DELETE /api/admin/dicts/items/:id */
  app.delete('/dicts/items/:id', async (request) => {
    const id = Number((request.params as { id: string }).id)
    if (!Number.isInteger(id)) return fail(ApiCode.INVALID_PARAM, '字典项 id 不对')

    const item = await prisma.dictItem.findUnique({ where: { id } })
    if (!item) return fail(ApiCode.NOT_FOUND, '字典项不存在')

    const type = await prisma.dictType.findUnique({ where: { code: item.typeCode } })
    const admin = await currentAdmin(request)

    await prisma.$transaction(async (tx) => {
      await tx.dictItem.delete({ where: { id } })
      await pushLog(
        {
          adminId: admin.id,
          adminName: admin.nickname,
          action: 'dict.delete',
          targetType: 'dict',
          targetId: item.id,
          targetName: `${type?.name ?? item.typeCode} / ${item.label}`,
          detail: `删除数据项 ${item.label}（${item.value}）`,
          ip: request.ip
        },
        tx
      )
    })

    return ok(null)
  })
}
