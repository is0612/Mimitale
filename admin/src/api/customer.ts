/**
 * 客户管理 —— 对应 src/types/admin.ts 的 5、6 号契约
 *
 * 「客户」= 在 Mimitale 客户端里注册使用的人。这个后台存在的意义就是管他们。
 */

import { request } from './request'
import type {
  Customer,
  CustomerDetail,
  CustomerListQuery,
  CustomerListRes,
  CreateCustomerReq,
  UpdateCustomerReq
} from '@/types'

/** 5. 客户列表（分页 + 关键词 + 状态筛选） */
export function fetchCustomers(query: CustomerListQuery): Promise<CustomerListRes> {
  return request<CustomerListRes>({
    url: '/admin/customers',
    method: 'get',
    params: query
  })
}

/** 6. 改客户状态（封禁 / 解封）、发会员。每次变更后端都会落一条操作日志 */
export function updateCustomer(id: number, payload: UpdateCustomerReq): Promise<Customer> {
  return request<Customer>({
    url: `/admin/customers/${id}`,
    method: 'patch',
    data: payload
  })
}

/** 7. 客户详情：客户本身 + 他的邀请码来自哪张卡 + 他身上的操作记录 */
export function fetchCustomerDetail(id: number): Promise<CustomerDetail> {
  return request<CustomerDetail>({
    url: `/admin/customers/${id}`,
    method: 'get'
  })
}

/**
 * 24. 后台代建客户 —— 等价于注册
 *
 * 建出来的号和客户端自己注册的一样：有凭证码、有邀请码、送 30 天试用，
 * 也算进「今日注册」。区别只有一条：不发邮件验验证码，密码由运营填。
 */
export function createCustomer(payload: CreateCustomerReq): Promise<Customer> {
  return request<Customer>({
    url: '/admin/customers',
    method: 'post',
    data: payload
  })
}

/**
 * 25. 删除客户 —— 真删，不可恢复
 *
 * 会一并清掉他的登录记录 / 使用会话 / 会员流水 / 公告已读；
 * 他发过的反馈保留正文但抹掉身份。用过的卡密不回收。
 */
export function deleteCustomer(id: number): Promise<null> {
  return request<null>({
    url: `/admin/customers/${id}`,
    method: 'delete'
  })
}
