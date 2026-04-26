const user = {
    name: 'Alex',
    greet: function() {
        return this.name;
    }
};

/*
const user = {
    name: 'Alex',
    greet: function() {
        return "Hello, " + this.name;
    }
};
*/
//TODO: binary operation still wrong
// 这里的 CallExpression 的 callee 是一个 MemberExpression (user.greet)
// 解释器需要提取出 user 作为 this
console.log(user.greet()); // "Hello, Alex"