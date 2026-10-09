import serial, sys, time
port = sys.argv[1]
s = serial.Serial(port, 115200)
# 经典 ESP 复位时序：RTS 脉冲复位（EN），DTR 保持释放（不进 BOOT）
s.dtr = False
s.rts = True
time.sleep(0.1)
s.rts = False
time.sleep(0.3)
s.reset_input_buffer()
end = time.time() + 12
buf = b''
while time.time() < end:
    n = s.in_waiting
    if n:
        buf += s.read(n)
    else:
        time.sleep(0.1)
s.close()
out = buf.decode('utf-8', 'replace')
sys.stdout.write(out)
