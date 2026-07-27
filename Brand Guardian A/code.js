figma.showUI(__html__, { width: 400, height: 600 });

figma.ui.onmessage = function(msg) {
  if (msg.type === 'apply-color') {
    var selection = figma.currentPage.selection;
    if (selection.length === 0) {
      figma.notify("⚠️ حددي عنصراً في فيغما لتطبيق اللون عليه!");
      return;
    }
    
    var hex = msg.color.replace('#', '');
    var r = parseInt(hex.substring(0, 2), 16) / 255;
    var g = parseInt(hex.substring(2, 4), 16) / 255;
    var b = parseInt(hex.substring(4, 6), 16) / 255;

    for (var i = 0; i < selection.length; i++) {
      var node = selection[i];
      if ('fills' in node) {
        node.fills = [{ type: 'SOLID', color: { r: r, g: g, b: b } }];
      }
    }
    figma.notify("✅ تم تطبيق اللون " + msg.color);
  }

  if (msg.type === 'capture-and-send') {
    var selectionList = figma.currentPage.selection;
    
    if (selectionList.length === 0) {
      figma.ui.postMessage({
        type: 'image-captured',
        base64: null,
        userPrompt: msg.userPrompt
      });
      return;
    }

    var selectedNode = selectionList[0];
    selectedNode.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 0.5 }
    }).then(function(bytes) {
      var binary = '';
      for (var i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      var base64Image = btoa(binary);

      figma.ui.postMessage({
        type: 'image-captured',
        base64: base64Image,
        userPrompt: msg.userPrompt
      });
    }).catch(function(err) {
      console.error(err);
    });
  }
};