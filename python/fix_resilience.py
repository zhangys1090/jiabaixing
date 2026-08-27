import re

filepath = r'c:\zy\jiabaixing\python\agent\core\resilience.py'
with open(filepath, 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip_next = False
for i, line in enumerate(lines):
    if skip_next:
        skip_next = False
        continue
    if line.strip() == 'import logging':
        continue
    if 'logger = logging.getLogger(__name__)' in line:
        continue
    if 'logger = StructuredLogger("resilience")' in line:
        continue
    new_lines.append(line)

with open(filepath, 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

with open(filepath, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace('logger.info(', 'log.info(')
content = content.replace('logger.warning(', 'log.warning(')
content = content.replace('logger.error(', 'log.error(')
content = content.replace('logger.debug(', 'log.debug(')

with open(filepath, 'w', encoding='utf-8') as f:
    f.write(content)

print('resilience.py fixed')
