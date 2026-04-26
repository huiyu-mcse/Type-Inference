const timer = {
    id: 'T1',
    start: function() {
        // 外层的 this 是 timer
        setTimeout(function() {
            // 这里的 this 默认指向全局(window)，拿不到 timer.id
            console.log("Timer ID: " + this.id); 
        }, 100);
    }
};

timer.start(); // 输出 "Timer ID: undefined"
