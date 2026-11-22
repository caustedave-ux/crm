"""合并主题后，直接截真实页面（不注入任何 CSS），验证 style.css 已经生效。"""
import os
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:5099'
TOKEN = os.environ.get('CRM_TOKEN', '')
PAGES = [('after-dashboard', '/dashboard'), ('after-documents', '/documents'),
         ('after-logistics', '/logistics'), ('after-customers', '/customers')]

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    ctx.add_cookies([{'name': 'crm_sid', 'value': TOKEN, 'domain': '127.0.0.1', 'path': '/'}])
    page = ctx.new_page()
    for name, url in PAGES:
        page.goto(BASE + url, wait_until='networkidle')
        page.wait_for_timeout(400)
        page.screenshot(path='design-demos/%s.png' % name, full_page=True)
        print('saved', name)

    mobile = browser.new_context(viewport={'width': 375, 'height': 812})
    mobile.add_cookies([{'name': 'crm_sid', 'value': TOKEN, 'domain': '127.0.0.1', 'path': '/'}])
    mp = mobile.new_page()
    mp.goto(BASE + '/dashboard', wait_until='networkidle')
    mp.wait_for_timeout(400)
    mp.screenshot(path='design-demos/after-mobile.png', full_page=True)
    print('saved mobile')
    browser.close()
