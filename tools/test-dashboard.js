'use strict';

const fs = require('fs');
const path = require('path');
const testDb = path.resolve('D:/Codex/tmp/crm-dashboard-test-' + process.pid + '.db');
fs.mkdirSync(path.dirname(testDb), { recursive: true });
process.env.CRM_DB = testDb;

const { db, run, get, seedBase } = require('../src/db');
const { seedSampleDocuments } = require('../src/documents');
const { nowStr, todayStr, addDays } = require('../src/util');
const { dashboardPage, dashboardPipelineCustomers } = require('../src/views/pages_core');

let failures = 0;
let testUser = null;
function assert(value, label) {
  if (!value) {
    failures++;
    console.error('FAIL ' + label);
  } else {
    console.log('PASS ' + label);
  }
}

function insertCustomer(id, name, status, country) {
  const stamp = nowStr();
  run(`INSERT INTO customers(id,user_id,company_name,status,country,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`, id, testUser.id, name, status, country, stamp, stamp);
}

function insertActivity(customerId, type, subject, nextDate) {
  const stamp = nowStr();
  return run(`INSERT INTO activities(customer_id,type,subject,activity_date,next_follow_date,archived,created_by,user_id,created_at,priority)
    VALUES(?,?,?,?,?,0,?,?,?,'高')`, customerId, type, subject, stamp, nextDate || '', testUser.username, testUser.id, stamp);
}

try {
  seedBase();
  seedSampleDocuments();
  testUser = get('SELECT * FROM users ORDER BY id LIMIT 1');
  if (!testUser) throw new Error('isolated test database did not seed a user');

  const today = todayStr();
  insertCustomer(880101, 'Dashboard New Inquiry Fixture', '潜在客户', 'Kenya');
  insertCustomer(880102, 'Dashboard Contacted Fixture', '意向客户', 'Nigeria');
  insertCustomer(880103, 'Dashboard Quoted Fixture', '报价中', 'Ghana');
  insertCustomer(880104, 'Dashboard Sample Fixture', '报价中', 'United Arab Emirates');
  insertCustomer(880105, 'Dashboard Won Fixture', '合作客户', 'Nigeria');
  insertCustomer(880106, 'Dashboard Document Won Fixture', '潜在客户', 'Kenya');
  insertCustomer(880107, 'Dashboard Pooled Fixture', '潜在客户', 'Kenya');
  insertCustomer(880108, 'Dashboard Follow-up Fixture', '潜在客户', 'Egypt');
  run('UPDATE customers SET in_pool=1 WHERE id=880107');

  insertActivity(880102, '电话', '确认产品需求', '');
  insertActivity(880104, '样品', '确认样品进度', addDays(today, 1));
  insertActivity(880108, 'WhatsApp', 'Fixture follow-up reminder', today);
  run(`INSERT INTO quote_history(quote_no,customer_id,product_name,status,quote_date,user_id,created_at,updated_at)
    VALUES('DASHBOARD-QUOTE-880103',880103,'Fixture product','已报价',?,?,?,?)`, today, testUser.id, nowStr(), nowStr());
  run(`INSERT INTO quote_history(quote_no,customer_id,product_name,status,quote_date,user_id,created_at,updated_at)
    VALUES('DASHBOARD-WON-880105',880105,'Fixture product','已成交',?,?,?,?)`, today, testUser.id, nowStr(), nowStr());
  run(`INSERT INTO documents(doc_no,doc_type,customer_id,user_id,currency,status,total_amount,created_at,updated_at)
    VALUES('DASHBOARD-PI-880106','pi',?,?,'EUR','已确认',19.5,?,?)`, 880106, testUser.id, nowStr(), nowStr());
  run(`INSERT INTO documents(doc_no,doc_type,customer_id,user_id,currency,status,total_amount,created_at,updated_at)
    VALUES('DASHBOARD-PI-880106-USD','pi',?,?,'USD','已确认',25,?,?)`, 880106, testUser.id, nowStr(), nowStr());

  const pipeline = dashboardPipelineCustomers(testUser.id);
  const stageById = Object.fromEntries(pipeline.map(customer => [Number(customer.id), customer.stage]));
  assert(stageById[880101] === 'inquiry', 'potential customers appear in the new-inquiry stage');
  assert(stageById[880102] === 'contacted', 'customers with actual activity appear in contacted');
  assert(stageById[880103] === 'quoted', 'active quote records drive quoted stage');
  assert(stageById[880104] === 'sample', 'open sample follow-up drives sample stage');
  assert(stageById[880105] === 'won', 'won quote drives customer deal stage');
  assert(stageById[880106] === 'won', 'confirmed sales document drives customer deal stage');
  assert(!stageById[880107], 'public-pool customers are excluded from private dashboard stages');

  const html = dashboardPage({ query: {}, user: testUser, flash: () => [] });
  const countryCount = get("SELECT COUNT(*) c FROM customers WHERE user_id=? AND COALESCE(in_pool,0)=0 AND TRIM(COALESCE(country,''))<>''", testUser.id).c;
  assert(html.includes('Dashboard New Inquiry Fixture'), 'dashboard stage cards use real customer records');
  assert(html.includes('Dashboard Quoted Fixture'), 'dashboard quoted card uses the customer with a real quote');
  assert(html.includes('Kenya') && html.includes('Nigeria'), 'country distribution uses customer profile countries');
  assert(html.includes('Fixture follow-up reminder'), 'priority list uses actual scheduled follow-up content');
  assert(html.includes('已填写 ' + countryCount + ' 家'), 'country distribution denominator excludes blank country fields');
  assert(!html.includes('Anna (US)') && !html.includes('Boutique Life'), 'removed static sample customer names');
  const monthlyCurrencySummary = html.match(/本月单据[\s\S]{0,100}/);
  assert(html.includes('EUR ') && html.includes('USD '), 'monthly document totals remain separated by currency' + (monthlyCurrencySummary ? ' (' + monthlyCurrencySummary[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() + ')' : ''));
  assert(!html.includes('NaN'), 'dashboard metrics render finite values');
} catch (error) {
  failures++;
  console.error(error.stack || error);
} finally {
  try { db.close(); } catch (error) {}
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(testDb + suffix); } catch (error) {}
  }
}

if (failures) process.exitCode = 1;
