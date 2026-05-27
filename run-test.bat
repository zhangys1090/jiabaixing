@echo off
cd /d c:\zy\jiabaixing
"c:\Program Files\nodejs\node.exe" "c:\zy\jiabaixing\node_modules\jest\bin\jest.js" "c:\zy\jiabaixing\tests\harness\step-evaluator.test.ts" --no-coverage
