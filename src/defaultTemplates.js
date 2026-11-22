'use strict';
// ============ 系统内置单据模板 ============
// 模板内可使用占位符：{{company.xxx}} {{customer.xxx}} {{contact.xxx}} {{doc.xxx}} {{item.xxx}}
// 明细循环区用 <!-- ITEMS:BEGIN --> ... <!-- ITEMS:END --> 包裹，内部每一行自动按明细重复
// item 提供：seq / name / name_en / name_html / model / unit / qty / price / amount / remark

const DOC_STYLE = `
<style>
  .doc-box{font-family:'Microsoft YaHei','PingFang SC',Arial,sans-serif;color:#111;font-size:13px;line-height:1.55;}
  .doc-box .doc-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px double #222;padding-bottom:8px;margin-bottom:10px;gap:8px;}
  .doc-box .logo img{max-height:70px;max-width:200px;}
  .doc-box .seller-name{font-size:16px;font-weight:700;}
  .doc-box .seller-name-en{font-size:11px;color:#444;}
  .doc-box .doc-title{text-align:center;font-size:21px;font-weight:800;letter-spacing:2px;}
  .doc-box .doc-title-en{text-align:center;font-size:11px;color:#333;letter-spacing:1px;}
  .doc-box .head-right{text-align:right;font-size:11px;max-width:40%;}
  .doc-box table.doc-items{width:100%;max-width:100%;border-collapse:collapse;margin:6px 0;table-layout:auto;}
  .doc-box table.doc-items th,.doc-box table.doc-items td{border:1px solid #333;padding:5px 6px;font-size:12px;word-break:break-all;}
  .doc-box table.doc-items th{background:#f0f0f0;text-align:center;font-weight:700;}
  .doc-box .amt{text-align:right;white-space:nowrap;}
  .doc-box .ctr{text-align:center;}
  .doc-box table.doc-items th.desc-cell{text-align:center;white-space:nowrap;}
  .doc-box table.doc-items td.desc-cell{text-align:center;white-space:nowrap;vertical-align:middle;}
  .doc-box .info-line{display:flex;justify-content:space-between;flex-wrap:wrap;margin-bottom:4px;font-size:12px;gap:4px 12px;}
  .doc-box .buyer-block{border:1px solid #666;padding:6px 8px;margin:6px 0;font-size:12px;}
  .doc-box .totals{margin:4px 0 4px auto;width:56%;border-collapse:collapse;font-size:12px;}
  .doc-box .totals td{padding:2px 8px;}
  .doc-box .totals .tt{font-size:14px;font-weight:800;}
  .doc-box .amount-cn{border:1px solid #333;padding:5px 8px;margin:6px 0;font-size:12px;}
  .doc-box .terms{margin:8px 0;font-size:12px;}
  .doc-box .terms b{font-weight:700;}
  .doc-box .sign{margin-top:26px;display:flex;justify-content:space-between;font-size:12px;gap:16px;}
  .doc-box .sign .col{width:48%;}
  .doc-box .sign-line{margin-top:36px;border-top:1px solid #333;padding-top:3px;}
  .doc-box .note{font-size:11px;color:#555;margin-top:8px;}
</style>`;

// 明细行（含单价/金额）
function itemRowPriced() {
  return `<tr>
  <td class="ctr">{{item.seq}}</td>
  <td class="desc-cell">{{item.image_html}}{{item.name_html}}</td>
  <td class="ctr">{{item.model}}</td>
  <td class="ctr">{{item.unit}}</td>
  <td class="ctr">{{item.qty}}</td>
  <td class="amt">{{item.price}}</td>
  <td class="amt">{{item.amount}}</td>
  <td>{{item.remark}}</td>
</tr>`;
}
// 明细行（无价格，装箱单用）
function itemRowPlain() {
  return `<tr>
  <td class="ctr">{{item.seq}}</td>
  <td class="desc-cell">{{item.image_html}}{{item.name_html}}</td>
  <td class="ctr">{{item.model}}</td>
  <td class="ctr">{{item.unit}}</td>
  <td class="ctr">{{item.qty}}</td>
  <td>{{item.remark}}</td>
</tr>`;
}

function itemsTable(priced) {
  const head = priced
    ? `<tr><th style="width:34px;">No.</th><th class="desc-cell">Description 品名</th><th style="width:72px;">Model 型号</th><th style="width:48px;">Unit 单位</th><th style="width:60px;">Qty 数量</th><th style="width:84px;">Unit Price 单价</th><th style="width:92px;">Amount 金额</th><th style="width:96px;">Remark 备注</th></tr>`
    : `<tr><th style="width:38px;">No.</th><th class="desc-cell">Description 品名</th><th style="width:84px;">Model 型号</th><th style="width:56px;">Unit 单位</th><th style="width:76px;">Qty 数量</th><th>Packing / Remark 包装与备注</th></tr>`;
  const row = priced ? itemRowPriced() : itemRowPlain();
  return `<table class="doc-items"><thead>${head}</thead><tbody>
<!-- ITEMS:BEGIN -->
${row}
<!-- ITEMS:END -->
</tbody></table>`;
}

function totalsBlock(withCn) {
  return `<table class="totals">
  <tr><td>小计 Subtotal</td><td class="amt">{{doc.currency}} {{doc.subtotal}}</td></tr>
  <tr><td>折扣 Discount</td><td class="amt">{{doc.currency}} {{doc.discount}}</td></tr>
  <tr><td>金额合计 Total Amount</td><td class="amt tt">{{doc.currency}} {{doc.total_amount}}</td></tr>
</table>${withCn ? `<div class="amount-cn">金额大写 Amount in Words：<b>{{doc.total_amount_cn}}</b></div>` : ''}`;
}

function buyerBlock() {
  return `<div class="buyer-block">
  <div><b>买方 Buyer / 客户 To：</b>{{customer.company_name}}　<span style="color:#555;">{{customer.name_en}}</span></div>
  <div>国家/地区 Country：{{customer.country}}　|　地址 Address：{{customer.address}}</div>
  <div>联系人 Attn：{{contact.name}}{{contact.position_html}}　电话 Tel：{{contact.mobile}}{{contact.phone_html}}　邮箱 Email：{{contact.email}}</div>
  <div>联系方式 Contact：{{customer.contact_line}}</div>
</div>`;
}

function infoLine(prefix) {
  return `<div class="info-line">
  <span>${prefix}编号 No.：<b>{{doc.doc_no}}</b></span>
  <span>单据日期 Date：{{doc.issue_date}}</span>
  <span>币种 Currency：{{doc.currency}}</span>
  <span>业务员 Sales：{{company.salesman}}</span>
</div>`;
}

function termsBlock(extraLines) {
  const lines = (extraLines || []).concat([
    ['付款方式 Payment Terms', '{{doc.payment_terms}}'],
    ['贸易条款 Trade Terms', '{{doc.trade_terms}}'],
    ['交货期 Delivery Time', '{{doc.delivery_date}}'],
    ['起运港 Port of Loading', '{{doc.port_loading}}'],
    ['目的港 Port of Destination', '{{doc.port_destination}}'],
  ]);
  return `<div class="terms">${lines.map(([k, v]) => `<div><b>${k}：</b>${v}</div>`).join('')}</div>`;
}

function bankBlock() {
  return `<div class="terms"><b>收款信息 Bank Information：</b><br>
  开户银行 Bank Name：{{company.bank_name}}<br>
  银行账号 Account No.：{{company.bank_account}}<br>
  SWIFT Code：{{company.bank_swift}}</div>`;
}

function sellerSign() {
  return `<div class="sign">
  <div class="col">卖方 Seller：{{company.name}}<br><span style="color:#555;">{{company.name_en}}</span><br>业务员 Sales：{{company.salesman}}<div class="sign-line">签名 Signature</div></div>
  <div class="col">买方 Buyer：{{customer.company_name}}<br><span style="color:#555;">{{customer.name_en}}</span><div class="sign-line">签名 / 盖章 Signature &amp; Stamp</div></div>
</div>`;
}

function headRight() {
  return `<div style="text-align:right;font-size:11px;max-width:42%;">{{company.address}}<br>Tel: {{company.tel}}　Fax: {{company.fax}}<br>Email: {{company.email}}　Web: {{company.website}}</div>`;
}

function quotation() {
  return `${DOC_STYLE}
<div class="doc-box">
  <div class="doc-head">
    <div class="logo">{{company.logo_html}}<div class="seller-name">{{company.name}}</div><div class="seller-name-en">{{company.name_en}}</div></div>
    <div><div class="doc-title">报 价 单</div><div class="doc-title-en">QUOTATION</div></div>
    ${headRight()}
  </div>
  ${infoLine('报价')}
  ${buyerBlock()}
  ${itemsTable(true)}
  ${totalsBlock(true)}
  <div class="terms"><b>报价有效期 Validity：</b>{{doc.valid_until}}</div>
  ${termsBlock()}
  <div class="terms"><b>备注 Remarks：</b>{{doc.remarks}}</div>
  ${sellerSign()}
  <div class="note">本报价单供商务洽谈使用，最终以双方确认的《销售合同》为准。This quotation is for negotiation only.</div>
</div>`;
}

function pi() {
  return `${DOC_STYLE}
<div class="doc-box">
  <div class="doc-head">
    <div class="logo">{{company.logo_html}}<div class="seller-name">{{company.name}}</div><div class="seller-name-en">{{company.name_en}}</div></div>
    <div><div class="doc-title">形 式 发 票</div><div class="doc-title-en">PROFORMA INVOICE</div></div>
    ${headRight()}
  </div>
  ${infoLine('形式发票')}
  ${buyerBlock()}
  ${ctnItemsTable(true, true)}
  ${totalsBlock(true)}
  <div class="terms"><b>报价有效期 Validity：</b>{{doc.valid_until}}</div>
  ${termsBlock()}
  <div class="terms"><b>备注 Remarks：</b>{{doc.remarks}}</div>
  {{doc.remark_images_block}}
  ${bankBlock()}
  ${sellerSign()}
  <div class="note">本形式发票用于订单确认及付款安排，请确认后签字回传。This Proforma Invoice is for order confirmation and payment arrangement only.</div>
</div>`;
}

function so() {
  return `${DOC_STYLE}
<div class="doc-box">
  <div class="doc-head">
    <div class="logo">{{company.logo_html}}<div class="seller-name">{{company.name}}</div><div class="seller-name-en">{{company.name_en}}</div></div>
    <div><div class="doc-title">销 售 合 同</div><div class="doc-title-en">SALES CONTRACT</div></div>
    ${headRight()}
  </div>
  ${infoLine('合同')}
  ${buyerBlock()}
  <div style="font-size:12px;"><b>合同双方经友好协商，同意按下列条款成交：</b><br>
  The Seller and the Buyer have agreed to conclude this contract according to the terms and conditions stipulated below:</div>
  ${ctnItemsTable()}
  ${totalsBlock(true)}
  ${termsBlock()}
  <div class="terms"><b>一般条款 / 备注 General Terms &amp; Remarks：</b>{{doc.remarks}}</div>
  ${bankBlock()}
  ${sellerSign()}
  <div class="note">本合同一式两份，双方签字盖章后生效。This contract is made in two originals and effective upon signature and stamp by both parties.</div>
</div>`;
}

function ci() {
  return `${DOC_STYLE}
<div class="doc-box">
  <div class="doc-head">
    <div class="logo">{{company.logo_html}}<div class="seller-name">{{company.name}}</div><div class="seller-name-en">{{company.name_en}}</div></div>
    <div><div class="doc-title">商 业 发 票</div><div class="doc-title-en">COMMERCIAL INVOICE</div></div>
    ${headRight()}
  </div>
  ${infoLine('发票')}
  ${buyerBlock()}
  ${itemsTable(true)}
  ${totalsBlock(true)}
  <div class="terms"><b>声明 Statement：</b>We hereby certify that the above goods are of Chinese origin and the information in this invoice is true and correct.<br>
  <b>原产地 Country of Origin：</b>China</div>
  <div class="terms"><b>备注 Remarks：</b>{{doc.remarks}}</div>
  ${sellerSign()}
  <div class="note">本商业发票用于出口报关及客户清关。This commercial invoice is for export declaration and customs clearance.</div>
</div>`;
}

function pl() {
  return `${DOC_STYLE}
<div class="doc-box">
  <div class="doc-head">
    <div class="logo">{{company.logo_html}}<div class="seller-name">{{company.name}}</div><div class="seller-name-en">{{company.name_en}}</div></div>
    <div><div class="doc-title">装 箱 单</div><div class="doc-title-en">PACKING LIST</div></div>
    ${headRight()}
  </div>
  ${infoLine('装箱单')}
  ${buyerBlock()}
  ${plItemsTable()}
  <div class="terms"><b>唛头 Shipping Marks：</b>{{doc.shipping_marks}}<br>
  <b>装箱说明 Packing Notes：</b>{{doc.remarks}}</div>
  ${sellerSign()}
</div>`;
}

// 采购单 PO 专用明细（纯中文）：图片/品名/颜色/箱数/每箱/总数量/单价/金额/备注
function poItemsTable() {
  const head = `<tr>
    <th style="width:40px;white-space:nowrap;">序号</th>
    <th style="width:60px;">图片</th>
    <th class="desc-cell">品名</th>
    <th style="width:52px;white-space:nowrap;">颜色</th>
    <th style="width:50px;white-space:nowrap;">箱数</th>
    <th style="width:56px;white-space:nowrap;">每箱</th>
    <th style="width:72px;white-space:nowrap;">总数量</th>
    <th style="width:78px;white-space:nowrap;">单价</th>
    <th style="width:90px;white-space:nowrap;">金额</th>
    <th style="width:100px;">备注</th>
  </tr>`;
  const row = `<tr>
    <td class="ctr">{{item.seq}}</td>
    <td class="ctr">{{item.image_html}}</td>
    <td class="desc-cell">{{item.name}}</td>
    <td class="ctr">{{item.color}}</td>
    <td class="ctr">{{item.ctn}}</td>
    <td class="ctr">{{item.per_ctn}}</td>
    <td class="ctr"><b>{{item.qty}}</b></td>
    <td class="amt">{{item.price}}</td>
    <td class="amt">{{item.amount}}</td>
    <td>{{item.remark}}</td>
  </tr>`;
  return `<table class="doc-items"><thead>${head}</thead><tbody>
<!-- ITEMS:BEGIN -->
${row}
<!-- ITEMS:END -->
</tbody></table>`;
}
// 采购单 PO 专用合计（纯中文）
function poTotalsBlock() {
  return `<table class="totals">
  <tr><td>小计</td><td class="amt">{{doc.currency}} {{doc.subtotal}}</td></tr>
  <tr><td>折扣</td><td class="amt">{{doc.currency}} {{doc.discount}}</td></tr>
  <tr><td>金额合计</td><td class="amt tt">{{doc.currency}} {{doc.total_amount}}</td></tr>
</table>`;
}

function poTemplate() {
  return `${DOC_STYLE}
<div class="doc-box">
  <div class="doc-head">
    <div class="logo">{{company.logo_html}}<div class="seller-name">{{company.name}}</div></div>
    <div><div class="doc-title">采 购 单</div></div>
    <div style="text-align:right;font-size:11px;max-width:42%;">{{company.address}}<br>电话：{{company.tel}}<br>邮箱：{{company.email}}</div>
  </div>
  <div class="info-line">
    <span>采购单编号：<b>{{doc.doc_no}}</b></span>
    <span>单据日期：{{doc.issue_date}}</span>
    <span>币种：{{doc.currency}}</span>
    <span>采购员：{{company.salesman}}</span>
  </div>
  <div class="buyer-block">
    <div><b>供应商：</b>{{supplier.name}}</div>
    <div>国家/地区：{{supplier.country}}　|　地址：{{supplier.address}}</div>
    <div>联系人：{{supplier.contact_name}}{{supplier.contact_position_html}}　电话：{{supplier.phone}}　邮箱：{{supplier.email}}</div>
  </div>
  <div style="font-size:12px;">我司同意按下列条款向贵司采购以下货物：</div>
  ${poItemsTable()}
  <div class="info-line"><span>总箱数：<b>{{doc.total_ctn}}</b></span></div>
  ${poTotalsBlock()}
  <div class="terms">
    <div><b>付款方式：</b>{{doc.payment_terms}}</div>
    <div><b>交货期：</b>{{doc.delivery_date}}</div>
  </div>
  <div class="terms"><b>备注 / 验收要求：</b>{{doc.remarks}}<br>
  <b>供应商付款条件：</b>{{supplier.payment_terms}}</div>
  <div class="sign">
    <div class="col">采购方：{{company.name}}<br>采购员：{{company.salesman}}<div class="sign-line">签名 / 盖章</div></div>
    <div class="col">供应商确认：{{supplier.name}}<div class="sign-line">签名 / 盖章</div></div>
  </div>
  <div class="note">本采购单一式两份，双方确认后生效，货到验收合格后按约定付款。</div>
</div>`;
}
// 装箱单专用明细：无单价金额；体积/总体积/重量/总重量；总体积=体积x件数，总重量=重量x件数
function plItemsTable() {
  const head = `<tr>
    <th style="width:34px;">No.</th>
    <th class="desc-cell">Description 品名</th>
    <th style="width:80px;">Model 型号</th>
    <th style="width:50px;">Unit 单位</th>
    <th style="width:58px;">件数<br>Qty/CTN</th>
    <th style="width:60px;">装箱数<br>CTN</th>
    <th style="width:66px;">总数量<br>Qty</th>
    <th style="width:66px;">Volume 体积(m³)</th>
    <th style="width:78px;">Total Vol 总体积</th>
    <th style="width:66px;">Weight 重量(kg)</th>
    <th style="width:78px;">Total Wt 总重量</th>
    <th style="width:90px;">Remark 备注</th>
  </tr>`;
  const row = `<tr>
    <td class="ctr">{{item.seq}}</td>
    <td class="desc-cell">{{item.name_html}}</td>
    <td class="ctr">{{item.model}}</td>
    <td class="ctr">{{item.unit}}</td>
    <td class="ctr">{{item.per_ctn}}</td>
    <td class="ctr">{{item.ctn}}</td>
    <td class="ctr">{{item.qty}}</td>
    <td class="ctr">{{item.volume}}</td>
    <td class="ctr">{{item.total_volume}}</td>
    <td class="ctr">{{item.weight}}</td>
    <td class="ctr">{{item.total_weight}}</td>
    <td>{{item.remark}}</td>
  </tr>`;
  return `<table class="doc-items"><thead>${head}</thead><tbody>
<!-- ITEMS:BEGIN -->
${row}
<!-- ITEMS:END -->
</tbody></table>
  <div class="info-line"><span>总体积 Total Volume：<b>{{doc.total_volume}} m³</b></span><span>总重量 Total Weight：<b>{{doc.total_weight}} kg</b></span></div>`;
}
// PI / 销售合同专用明细：ITEM NO, PICTURE, COLOR, CTN, QTY(每箱), T.T QTY(总), PRICE, AMOUNT
function ctnItemsTable(descPlain, showCtnTotal) {
  const descTok = descPlain ? "{{item.name}}" : "{{item.name_html}}";
  const head = `<tr>
    <th style="width:34px;">No.</th>
    <th style="width:70px;">Picture<br>图片</th>
    <th class="desc-cell">Description 品名</th>
    <th style="width:64px;">Color<br>颜色</th>
    <th style="width:52px;">CTN<br>箱数</th>
    <th style="width:62px;">QTY<br>每箱</th>
    <th style="width:70px;">T.T QTY<br>总数量</th>
    <th style="width:82px;">Unit Price<br>单价</th>
    <th style="width:92px;">Amount<br>金额</th>
  </tr>`;
  const row = `<tr>
    <td class="ctr">{{item.seq}}</td>
    <td class="ctr">{{item.image_html}}</td>
    <td class="desc-cell">${descTok}</td>
    <td class="ctr">{{item.color}}</td>
    <td class="ctr">{{item.ctn}}</td>
    <td class="ctr">{{item.per_ctn}}</td>
    <td class="ctr"><b>{{item.qty}}</b></td>
    <td class="amt">{{item.price}}</td>
    <td class="amt">{{item.amount}}</td>
  </tr>`;
  return `<table class="doc-items"><thead>${head}</thead><tbody>
<!-- ITEMS:BEGIN -->
${row}
<!-- ITEMS:END -->
</tbody></table>` + (showCtnTotal ? `<div class="info-line"><span>总箱数 Total CTN：<b>{{doc.total_ctn}}</b></span></div>` : '');
}
const DOC_TYPES = [
  { key: 'quotation', name: '报价单', en: 'Quotation', prefix: 'QUO' },
  { key: 'pi', name: '形式发票 PI', en: 'Proforma Invoice', prefix: 'PI' },
  { key: 'so', name: '销售合同/订单', en: 'Sales Contract', prefix: 'SO' },
  { key: 'ci', name: '商业发票 CI', en: 'Commercial Invoice', prefix: 'CI' },
  { key: 'pl', name: '装箱单', en: 'Packing List', prefix: 'PL' },
  { key: 'po', name: '采购单', en: 'Purchase Order', prefix: 'PO' },
];
const DOC_TYPE_MAP = Object.fromEntries(DOC_TYPES.map(t => [t.key, t]));

const DEFAULT_TEMPLATES = [
  { doc_type: 'quotation', name: '标准报价单（中英双语）', description: '系统内置：买卖双方信息、明细、金额大写、条款与签章。', content: quotation() },
  { doc_type: 'pi', name: '标准形式发票 PI（中英双语）', description: '系统内置：含收款银行信息与买方确认栏，用于订单确认与付款。', content: pi() },
  { doc_type: 'so', name: '标准销售合同（中英双语）', description: '系统内置：含一般条款、银行信息及双方签章栏。', content: so() },
  { doc_type: 'ci', name: '标准商业发票 CI（中英双语）', description: '系统内置：用于出口报关与客户清关。', content: ci() },
  { doc_type: 'pl', name: '标准装箱单 PL（中英双语）', description: '系统内置：无价格栏，含唛头与装箱说明。', content: pl() },
  { doc_type: 'po', name: '标准采购单 PO（中文）', description: '系统内置：纯中文采购单，明细含箱数/每箱/总数量，含供应商确认签章，可配合库存入库。', content: poTemplate() },
];

module.exports = { DOC_TYPES, DOC_TYPE_MAP, DEFAULT_TEMPLATES };






