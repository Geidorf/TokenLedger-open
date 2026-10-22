//! 计费周期（方案 §2.5）：按本地日历日期划分的 `[本次计费日, 下次计费日)`。
//!
//! 月付：计费日为 a 时，每月的计费日期取 `min(a, 当月天数)`，计费日 31 在 2 月落在
//! 28 或 29 日；年付：以开始日期的月日为计费日，2 月 29 日在平年按 2 月 28 日。
//! 本模块只给出周期的定义；按周期折算订阅费、统计 API 等值与回本倍数属于 B2
//! （`get_cost_breakdown_local`）。

use chrono::{Datelike, NaiveDate};

use super::{CostBillingCycle, CostSubscriptionPlan};

/// 一个计费周期：`start` 含、`end` 不含，都是本地日历日期。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BillingCycle {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

impl BillingCycle {
    /// 周期的日历天数：按日期相减，与夏令时无关。
    pub fn days(&self) -> i64 {
        (self.end - self.start).num_days()
    }
}

impl CostSubscriptionPlan {
    /// 包含 `date` 的计费周期。周期只由计费日（月付）或开始日期的月日（年付）决定，
    /// 与订阅的起止日期无关：首个与最后一个周期是否只部分有效，由调用方按起止日期
    /// 判断并按天折算。只在 chrono 可表示的日期上下界附近返回 `None`。
    pub fn billing_cycle_containing(&self, date: NaiveDate) -> Option<BillingCycle> {
        match self.cycle {
            CostBillingCycle::Monthly => monthly_cycle_containing(self.anchor_day, date),
            CostBillingCycle::Yearly => yearly_cycle_containing(self.start_date, date),
        }
    }
}

/// 把 `(year, month)` 平移 `delta` 个月。
fn shift_month(year: i32, month: u32, delta: i32) -> (i32, u32) {
    let index = year * 12 + month as i32 - 1 + delta;
    (index.div_euclid(12), index.rem_euclid(12) as u32 + 1)
}

fn days_in_month(year: i32, month: u32) -> Option<u32> {
    let (next_year, next_month) = shift_month(year, month, 1);
    NaiveDate::from_ymd_opt(next_year, next_month, 1)?
        .pred_opt()
        .map(|last| last.day())
}

/// 月付在某个月的计费日期：计费日大于当月天数时按月末。
fn monthly_billing_date(year: i32, month: u32, anchor_day: u8) -> Option<NaiveDate> {
    let day = u32::from(anchor_day).min(days_in_month(year, month)?);
    NaiveDate::from_ymd_opt(year, month, day)
}

fn monthly_cycle_containing(anchor_day: u8, date: NaiveDate) -> Option<BillingCycle> {
    let (year, month) = (date.year(), date.month());
    let (start_year, start_month) = if date >= monthly_billing_date(year, month, anchor_day)? {
        (year, month)
    } else {
        shift_month(year, month, -1)
    };
    let (end_year, end_month) = shift_month(start_year, start_month, 1);
    Some(BillingCycle {
        start: monthly_billing_date(start_year, start_month, anchor_day)?,
        end: monthly_billing_date(end_year, end_month, anchor_day)?,
    })
}

/// 年付在某一年的计费日期：开始日期的月日，2 月 29 日在平年按 2 月 28 日。
fn yearly_billing_date(anchor: NaiveDate, year: i32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(year, anchor.month(), anchor.day()).or_else(|| {
        (anchor.month() == 2 && anchor.day() == 29)
            .then(|| NaiveDate::from_ymd_opt(year, 2, 28))
            .flatten()
    })
}

fn yearly_cycle_containing(anchor: NaiveDate, date: NaiveDate) -> Option<BillingCycle> {
    let year = date.year();
    let start_year = if date >= yearly_billing_date(anchor, year)? {
        year
    } else {
        year - 1
    };
    Some(BillingCycle {
        start: yearly_billing_date(anchor, start_year)?,
        end: yearly_billing_date(anchor, start_year + 1)?,
    })
}
