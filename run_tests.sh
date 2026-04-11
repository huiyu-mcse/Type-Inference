#!/bin/bash

# 递归查找 Tests 文件夹下的所有文件
# 只匹配 .js 文件，且排除掉 .out 文件
find ./Tests -type f -name "*.js" -not -path '*/.*' | while read -r file; do
    
    # 1. 去掉路径，只留文件名 (例如 ./Tests/Objects/t1.js -> t1.js)
    base_name=$(basename "$file")
    
    # 2. 去掉 .js 后缀 (例如 t1.js -> t1)
    name_no_ext="${base_name%.js}"
    
    # 3. 获取文件所在的目录路径 (例如 ./Tests/Objects)
    dir_name=$(dirname "$file")
    
    echo "Processing: $file ..."
    
    # 执行并将结果保存为 [原名].out
    # 输出路径示例：./Tests/Objects/t1.out
    node infer.js "$file" | node solver_new.js > "${dir_name}/${name_no_ext}.out"
    
done

