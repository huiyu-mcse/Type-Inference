var state = {};
state.count = 0;
var valid = true;

function g(valid) {
  while (valid) {
    state.count = state.count + 1;
  }
}
