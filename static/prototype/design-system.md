# Neo-B2B Trade OS · 设计系统规范

来源：Stitch 项目「PRD Product Prototype Generator」（ID: 9836361844615305133）

## 1. 品牌与风格
面向跨境 B2B 外贸 CRM：高对比 Neo-Modernism + 柔和圆角卡片。
- 权威与安全：曜石黑头部、深色主色、精确几何对齐
- 操作清晰：白色画布、充足留白、1px 细边框，降低信息密度压力
- 动态能量：珊瑚橙 + 电光黄作为高亮信号色

## 2. 颜色
| 用途 | 色值 |
|---|---|
| 主色 Primary | `#121316` |
| 主色悬停 | `#282A2E` |
| 辅助色 Secondary（珊瑚橙） | `#FF5C38` |
| 信号黄 Tertiary | `#FBE32D` |
| 功能绿 Functional Green | `#22C55E` |
| 背景 Background | `#F4F5F7` |
| 卡片表面 Surface | `#FFFFFF` |
| 边框 Border | `#E5E7EB` |
| 主文字 On Surface | `#191C1E` |
| 次要文字 Muted | `#6B7280` |
| 错误 Error | `#BA1A1A` |

## 3. 字体与字号（Inter）
| Token | 字号 / 字重 / 行高 |
|---|---|
| display-lg | 36px / 700 / 44px，字距 -0.03em |
| headline-lg | 28px / 700 / 36px |
| headline-lg-mobile | 22px / 700 / 28px |
| headline-md | 20px / 600 / 28px |
| headline-sm | 16px / 600 / 24px |
| body-lg | 16px / 400 / 24px |
| body-md | 14px / 400 / 20px |
| body-sm | 12px / 400 / 16px |
| label-md | 13px / 500 / 18px |
| label-sm | 11px / 600 / 14px |
| numeric-stat | 32px / 700 / 38px，等宽数字 |

## 4. 圆角与间距
- 圆角：sm 4px；默认 8px；md 12px；lg 16px；xl 24px；full 9999px
- 间距：xs 6px；sm 10px；md 16px；lg 24px；xl 32px
- 栅格：12 列，最大宽度 1600px，桌面间距 20px，移动端 12px

## 5. 组件规范
- **按钮**：主按钮黑底白字，胶囊/圆角；图标按钮 36–40px 圆形；过滤器为灰色轨道内的胶囊分段
- **KPI 卡片**：深色高亮卡（黑底、绿色涨幅、白色辅助文字）+ 白色分析卡（1px 边框、大号数字）
- **输入与搜索**：深色头部内为半透明白玻璃搜索框；常规输入白底 + 1px `#D1D5DB` 边框，聚焦 2px 黑环
- **徽章**：通知用珊瑚橙圆形数字；品牌标识用信号黄底黑图标
- **外贸专用**：RFQ/订单流程条（橙=紧急、黄=清关、绿=信用证确认）；多币种图表（8px 圆角柱顶 + 黑色提示胶囊）

## 6. 阴影层级
- 卡片：`0 8px 24px -4px rgba(18,19,22,.04), 0 2px 6px -1px rgba(18,19,22,.02)`
- 浮层/弹窗：`0 16px 32px -6px rgba(18,19,22,.12)` + 1px 细边框
- 深色区块（头部/KPI）：纯色无阴影