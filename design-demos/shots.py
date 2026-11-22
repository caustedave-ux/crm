"""给当前 CRM 页面套上一份主题 CSS 并截图（不修改任何生产文件）。

用法：
  python tools/shots.py <主题css路径> <输出png> <url> [宽] [高]
"""
import os
import sys

from playwright.sync_api import sync_playwright

theme = sys.argv[1]
out = sys.argv[2]
url = sys.argv[3]
w = int(sys.argv[4]) if len(sys.argv) > 4 else 1440
h = int(sys.argv[5]) if len(sys.argv) > 5 else 900
token = os.environ.get('CRM_TOKEN', '')

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=1)
    if token:
        ctx.add_cookies([{'name': 'crm_sid', 'value': token, 'domain': '127.0.0.1', 'path': '/'}])
    page = ctx.new_page()
    page.goto(url, wait_until='networkidle')
    page.add_style_tag(path=theme)
    page.wait_for_timeout(500)
    page.screenshot(path=out, full_page=True)
    browser.close()

print('saved', out)
